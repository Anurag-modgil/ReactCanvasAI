(function() {
  if (window.__reactcanvas_inspector_loaded) return;
  window.__reactcanvas_inspector_loaded = true;

  console.log('[ReactCanvas Inspector] Loaded. Using postMessage bridge.');

  // ─── State ────────────────────────────────────────────────────────────────
  let inspectModeActive = false;
  let hoveredElement   = null;

  // ─── Overlay + label ──────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = '__reactcanvas-overlay';
  Object.assign(overlay.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: '2147483647',
    border: '2px solid rgba(99,102,241,0.9)',
    backgroundColor: 'rgba(99,102,241,0.08)',
    transition: 'top .07s ease,left .07s ease,width .07s ease,height .07s ease',
    display: 'none', boxSizing: 'border-box'
  });

  const label = document.createElement('div');
  Object.assign(label.style, {
    position: 'absolute', top: '-22px', left: '-2px',
    background: 'rgba(99,102,241,0.95)', color: '#fff',
    padding: '2px 8px', fontSize: '11px',
    fontFamily: 'ui-monospace,monospace', borderRadius: '3px 3px 0 0',
    whiteSpace: 'nowrap', pointerEvents: 'none'
  });
  overlay.appendChild(label);
  document.body.appendChild(overlay);

  // ─── postMessage helpers ──────────────────────────────────────────────────
  function sendToParent(type, payload) {
    try {
      window.parent.postMessage({ source: 'reactcanvas-inspector', type, payload }, '*');
    } catch (e) {
      console.warn('[ReactCanvas Inspector] postMessage failed', e);
    }
  }

  // Listen for commands from parent webview (e.g. SET_INSPECT_MODE)
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.source !== 'reactcanvas-parent') return;
    if (e.data.type === 'SET_INSPECT_MODE') {
      inspectModeActive = !!e.data.payload.active;
      console.log('[ReactCanvas Inspector] Inspect mode:', inspectModeActive);
      if (!inspectModeActive) hideOverlay();
    }
  });

  // ─── React Fiber helpers ──────────────────────────────────────────────────
  function getFiber(el) {
    const key = Object.keys(el).find(k =>
      k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    return key ? el[key] : null;
  }

  function getFiberName(fiber) {
    if (!fiber) return null;
    const t = fiber.type;
    if (!t) return null;
    if (typeof t === 'string') return t;
    return t.displayName || t.name || null;
  }

  // Walk up fiber tree collecting named React components
  function buildFiberHierarchy(fiber) {
    const result = [];
    let cur = fiber;
    while (cur) {
      const name = getFiberName(cur);
      // Only include custom components (uppercase first letter or known named functions)
      if (name && /^[A-Z]/.test(name)) {
        const src = cur._debugSource;
        result.push({
          name,
          filePath:     src ? src.fileName   : null,
          lineNumber:   src ? src.lineNumber  : null,
          columnNumber: src ? (src.columnNumber || 0) : 0
        });
      }
      cur = cur.return;
    }
    return result;
  }

  // ─── Walk DOM upward collecting data-rc-* nodes ───────────────────────────
  function buildDomHierarchy(el) {
    const result = [];
    let cur = el;
    while (cur && cur !== document.body) {
      const f = cur.getAttribute && cur.getAttribute('data-rc-file');
      const l = cur.getAttribute && cur.getAttribute('data-rc-line');
      if (f && l) {
        const fiber = getFiber(cur);
        const name  = (fiber && getFiberName(fiber)) || cur.tagName.toLowerCase();
        result.push({
          name,
          filePath:     f,
          lineNumber:   parseInt(l, 10),
          columnNumber: parseInt(cur.getAttribute('data-rc-column') || '0', 10)
        });
      }
      cur = cur.parentElement;
    }
    return result;
  }

  // ─── Build full metadata for a clicked element ────────────────────────────
  function buildMetadata(el) {
    if (!el || el === document.body || el === document.documentElement) return null;

    // 1. DOM attributes (data-rc-*)
    const domHierarchy  = buildDomHierarchy(el);

    // 2. React Fiber fallback
    const fiber         = getFiber(el);
    const fiberHierarchy = fiber ? buildFiberHierarchy(fiber) : [];

    // Merge: prefer domHierarchy, fall back to fiber
    const hierarchy = domHierarchy.length > 0 ? domHierarchy : fiberHierarchy;

    // Find the best source coordinates
    // — from the element itself first, then nearest ancestor
    let filePath     = el.getAttribute && el.getAttribute('data-rc-file');
    let lineNumber   = el.getAttribute && el.getAttribute('data-rc-line')
                         ? parseInt(el.getAttribute('data-rc-line'), 10) : null;
    let columnNumber = el.getAttribute && el.getAttribute('data-rc-column')
                         ? parseInt(el.getAttribute('data-rc-column'), 10) : 0;

    if (!filePath && domHierarchy.length > 0) {
      filePath     = domHierarchy[0].filePath;
      lineNumber   = domHierarchy[0].lineNumber;
      columnNumber = domHierarchy[0].columnNumber;
    }
    if (!filePath && fiberHierarchy.length > 0) {
      filePath     = fiberHierarchy[0].filePath;
      lineNumber   = fiberHierarchy[0].lineNumber;
      columnNumber = fiberHierarchy[0].columnNumber;
    }

    const componentName = hierarchy.length > 0 ? hierarchy[0].name : el.tagName.toLowerCase();

    return {
      tagName:       el.tagName.toLowerCase(),
      componentName,
      innerText:     (el.innerText || '').slice(0, 200),
      classList:     Array.from(el.classList),
      className:     el.className || '',
      filePath,
      lineNumber,
      columnNumber,
      hierarchy
    };
  }

  // ─── Overlay positioning ──────────────────────────────────────────────────
  function showOverlay(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    Object.assign(overlay.style, {
      top: r.top + 'px', left: r.left + 'px',
      width: r.width + 'px', height: r.height + 'px',
      display: 'block'
    });
    const meta = buildMetadata(el);
    label.innerText = meta
      ? (meta.componentName !== meta.tagName ? `<${meta.componentName}> · ${meta.tagName}` : meta.tagName)
      : el.tagName.toLowerCase();
  }

  function hideOverlay() {
    overlay.style.display = 'none';
    hoveredElement = null;
  }

  // ─── Mousemove ────────────────────────────────────────────────────────────
  document.addEventListener('mousemove', function(e) {
    if (!inspectModeActive) return;
    const t = e.target;
    if (t === overlay || overlay.contains(t)) return;
    if (t !== hoveredElement) {
      hoveredElement = t;
      showOverlay(t);
    }
  }, true);

  // ─── Click ────────────────────────────────────────────────────────────────
  document.addEventListener('click', function(e) {
    if (!inspectModeActive) return;
    const t = e.target;
    if (t === overlay || overlay.contains(t)) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    const meta = buildMetadata(t);

    if (meta) {
      console.log('[ReactCanvas Inspector] Selected:', meta.componentName, meta.filePath, meta.lineNumber);
      sendToParent('ELEMENT_SELECTED', meta);
    } else {
      // Still send even without file mapping so the hierarchy panel shows the tag
      sendToParent('ELEMENT_SELECTED', {
        tagName: t.tagName.toLowerCase(),
        componentName: t.tagName.toLowerCase(),
        innerText: (t.innerText || '').slice(0, 200),
        classList: Array.from(t.classList),
        className: t.className || '',
        filePath: null,
        lineNumber: null,
        columnNumber: 0,
        hierarchy: []
      });
    }
  }, true);

  // Notify parent that inspector is ready
  sendToParent('INSPECTOR_READY', {});
  console.log('[ReactCanvas Inspector] Ready. Waiting for SET_INSPECT_MODE.');
})();
