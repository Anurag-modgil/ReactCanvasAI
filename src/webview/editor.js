(function() {
  const vscode = acquireVsCodeApi();

  // Elements
  const devServerUrlInput = document.getElementById('dev-server-url');
  const btnConnect = document.getElementById('btn-connect');
  const statusBadge = document.getElementById('status-badge');
  const btnInspect = document.getElementById('btn-inspect');
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  const btnRestore = document.getElementById('btn-restore');
  
  const browserAddress = document.getElementById('browser-address');
  const previewIframe = document.getElementById('preview-iframe');
  const iframePlaceholder = document.getElementById('iframe-placeholder');

  const hierarchyTree = document.getElementById('hierarchy-tree');
  const selectedCompBadge = document.getElementById('selected-component-badge');

  // Properties Inputs
  const propText = document.getElementById('prop-text');
  const propClasses = document.getElementById('prop-classes');
  const pAll = document.getElementById('p-all');
  const px = document.getElementById('px');
  const py = document.getElementById('py');
  const mAll = document.getElementById('m-all');
  const mx = document.getElementById('mx');
  const my = document.getElementById('my');
  const sizeW = document.getElementById('size-w');
  const sizeH = document.getElementById('size-h');
  const fontSize = document.getElementById('font-size');
  const borderRadius = document.getElementById('border-radius');
  const bgColor = document.getElementById('bg-color');
  const textColor = document.getElementById('text-color');
  const btnApplyProps = document.getElementById('btn-apply-props');

  // AI Inputs
  const scopeLock = document.getElementById('scope-lock');
  const chatHistory = document.getElementById('chat-history');
  const aiLoading = document.getElementById('ai-loading');
  const diffContainer = document.getElementById('diff-container');
  const diffFilename = document.getElementById('diff-filename');
  const diffCode = document.getElementById('diff-code').querySelector('code');
  const btnDiffReject = document.getElementById('btn-diff-reject');
  const btnDiffAccept = document.getElementById('btn-diff-accept');
  const aiPrompt = document.getElementById('ai-prompt');
  const btnAskAi = document.getElementById('btn-ask-ai');

  // State
  let isInspectMode = false;
  let isConnected = false;
  let activeSelection = null; // ElementSelectionPayload
  let proposedAiDiff = null;

  // 1. Connect Dev Server
  btnConnect.addEventListener('click', () => {
    const url = devServerUrlInput.value.trim();
    if (!url) return;

    vscode.postMessage({
      type: 'CONNECT_DEV_SERVER',
      payload: { devServerUrl: url }
    });
  });

  // 2. Toggle Inspect Mode
  btnInspect.addEventListener('click', () => {
    isInspectMode = !isInspectMode;
    updateInspectButtonState();
    vscode.postMessage({
      type: 'TOGGLE_INSPECT_MODE',
      payload: { active: isInspectMode }
    });
  });

  function updateInspectButtonState() {
    if (isInspectMode) {
      btnInspect.classList.add('active');
    } else {
      btnInspect.classList.remove('active');
    }
    // Forward the status to the iframe
    if (previewIframe && previewIframe.contentWindow) {
      previewIframe.contentWindow.postMessage({
        source: 'reactcanvas-parent',
        type: 'SET_INSPECT_MODE',
        payload: { active: isInspectMode }
      }, '*');
    }
  }

  // 3. Undo / Redo / Restore Actions
  btnUndo.addEventListener('click', () => vscode.postMessage({ type: 'UNDO' }));
  btnRedo.addEventListener('click', () => vscode.postMessage({ type: 'REDO' }));
  btnRestore.addEventListener('click', () => vscode.postMessage({ type: 'RESTORE' }));

  // 4. Listen to Messages from Extension Host AND the iframe
  window.addEventListener('message', (event) => {
    const message = event.data;

    // A. Intercept events from the inspector inside the iframe
    if (message && message.source === 'reactcanvas-inspector') {
      console.log('[ReactCanvas Webview] Received message from iframe:', message.type);
      if (message.type === 'ELEMENT_SELECTED') {
        // Forward it to the extension host
        vscode.postMessage({
          type: 'ELEMENT_SELECTED',
          payload: message.payload
        });
      } else if (message.type === 'INSPECTOR_READY') {
        // Automatically sync current inspect mode state with the loaded iframe
        if (previewIframe && previewIframe.contentWindow) {
          previewIframe.contentWindow.postMessage({
            source: 'reactcanvas-parent',
            type: 'SET_INSPECT_MODE',
            payload: { active: isInspectMode }
          }, '*');
        }
      }
      return;
    }

    // B. Handle events from the extension host
    console.log('[ReactCanvas Webview] Received message from extension host:', message.type);

    switch (message.type) {
      case 'SERVER_CONNECTED':
        isConnected = true;
        statusBadge.innerText = 'Connected';
        statusBadge.className = 'status-indicator connected';
        
        // Remove placeholder and show proxy frame
        iframePlaceholder.style.display = 'none';
        const proxyUrl = `http://localhost:${message.payload.proxyPort}/`;
        browserAddress.innerText = proxyUrl;
        previewIframe.src = proxyUrl;
        break;

      case 'SERVER_ERROR':
        isConnected = false;
        statusBadge.innerText = 'Error';
        statusBadge.className = 'status-indicator disconnected';
        appendSystemMessage(`Failed to bind to server: ${message.payload.error}`);
        break;

      case 'ELEMENT_SELECTED':
        // Turn off inspect mode to let developer select props visually
        isInspectMode = false;
        updateInspectButtonState();

        activeSelection = message.payload;
        selectedCompBadge.innerText = activeSelection.componentName;
        selectedCompBadge.title = activeSelection.filePath || 'No source file mapped';

        renderHierarchy(activeSelection.hierarchy);
        populateProperties(activeSelection);

        if (activeSelection.filePath) {
          enableFormInputs(true);
          appendSystemMessage(`Selected component <${activeSelection.componentName}> from source.`);
        } else {
          enableFormInputs(false);
          appendSystemMessage(`Selected element <${activeSelection.tagName}> (no source mapping found). You cannot edit this element.`);
        }
        break;

      case 'HISTORY_STATE':
        btnUndo.disabled = !message.payload.canUndo;
        btnRedo.disabled = !message.payload.canRedo;
        btnRestore.disabled = !message.payload.canRestore;
        break;

      case 'AI_DIFF_GENERATING':
        aiLoading.style.display = 'flex';
        break;

      case 'AI_DIFF_GENERATED':
        aiLoading.style.display = 'none';
        proposedAiDiff = message.payload;
        showDiff(proposedAiDiff);
        break;

      case 'AI_ERROR':
        aiLoading.style.display = 'none';
        appendSystemMessage(`AI Error: ${message.payload.error}`);
        break;
    }
  });

  // Render Component Hierarchy Tree
  function renderHierarchy(hierarchy) {
    hierarchyTree.innerHTML = '';
    if (!hierarchy || hierarchy.length === 0) {
      hierarchyTree.innerHTML = '<span class="empty-state">No components detected in fiber</span>';
      return;
    }

    hierarchy.forEach((item, index) => {
      const node = document.createElement('div');
      node.className = `hierarchy-node ${index === 0 ? 'active' : ''}`;
      
      const arrow = document.createElement('span');
      arrow.className = 'node-arrow';
      arrow.innerText = '↳';
      
      const text = document.createElement('span');
      text.innerText = item.name;
      
      const loc = document.createElement('span');
      loc.className = 'node-loc';
      if (item.filePath) {
        const fileBasename = item.filePath.split('/').pop();
        loc.innerText = `${fileBasename}:${item.lineNumber}`;
      } else {
        loc.innerText = 'unknown';
      }

      node.appendChild(arrow);
      node.appendChild(text);
      node.appendChild(loc);

      node.addEventListener('click', () => {
        // Highlight active tree item
        document.querySelectorAll('.hierarchy-node').forEach(n => n.classList.remove('active'));
        node.classList.add('active');

        // Update active selection location referencing the clicked parent component
        activeSelection.filePath = item.filePath;
        activeSelection.lineNumber = item.lineNumber;
        activeSelection.columnNumber = item.columnNumber;
        activeSelection.componentName = item.name;

        selectedCompBadge.innerText = item.name;
        selectedCompBadge.title = item.filePath || 'No source file mapped';
        
        if (item.filePath) {
          enableFormInputs(true);
        } else {
          enableFormInputs(false);
        }
      });

      hierarchyTree.appendChild(node);
    });
  }

  // Parse list of styles to fill input controls
  function populateProperties(meta) {
    propText.value = meta.innerText || '';
    propClasses.value = meta.className || '';

    // Clear previous inputs
    pAll.value = ''; px.value = ''; py.value = '';
    mAll.value = ''; mx.value = ''; my.value = '';
    sizeW.value = ''; sizeH.value = '';
    fontSize.value = ''; borderRadius.value = '';
    bgColor.value = ''; textColor.value = '';

    const classes = meta.classList || [];

    classes.forEach(cls => {
      // Spacing
      if (cls.startsWith('p-')) pAll.value = cls;
      else if (cls.startsWith('px-')) px.value = cls;
      else if (cls.startsWith('py-')) py.value = cls;
      else if (cls.startsWith('m-')) mAll.value = cls;
      else if (cls.startsWith('mx-')) mx.value = cls;
      else if (cls.startsWith('my-')) my.value = cls;
      // Size
      else if (cls.startsWith('w-')) sizeW.value = cls;
      else if (cls.startsWith('h-')) sizeH.value = cls;
      // Border Radius
      else if (cls.startsWith('rounded-') || cls === 'rounded') borderRadius.value = cls;
      // Typography Size
      else if (cls.startsWith('text-') && ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl'].some(s => cls.endsWith(s))) {
        fontSize.value = cls;
      }
      // Colors
      else if (cls.startsWith('bg-')) bgColor.value = cls;
      else if (cls.startsWith('text-') && !fontSize.value) textColor.value = cls;
    });
  }

  function enableFormInputs(enabled) {
    propText.disabled = !enabled;
    propClasses.disabled = !enabled;
    pAll.disabled = !enabled;
    px.disabled = !enabled;
    py.disabled = !enabled;
    mAll.disabled = !enabled;
    mx.disabled = !enabled;
    my.disabled = !enabled;
    sizeW.disabled = !enabled;
    sizeH.disabled = !enabled;
    fontSize.disabled = !enabled;
    borderRadius.disabled = !enabled;
    bgColor.disabled = !enabled;
    textColor.disabled = !enabled;
    btnApplyProps.disabled = !enabled;
    aiPrompt.disabled = !enabled;
    btnAskAi.disabled = !enabled;
  }

  // 5. Apply Visual Editor Modifications
  btnApplyProps.addEventListener('click', () => {
    if (!activeSelection) return;

    // Retrieve modified class names list
    let classStr = propClasses.value.trim();
    let classes = classStr.split(/\s+/).filter(Boolean);

    // Helper: update or inject a specific class pattern
    function mergeClass(val, prefix) {
      if (val) {
        // Remove existing class with prefix
        classes = classes.filter(c => !c.startsWith(prefix));
        classes.push(val);
      }
    }

    mergeClass(pAll.value.trim(), 'p-');
    mergeClass(px.value.trim(), 'px-');
    mergeClass(py.value.trim(), 'py-');
    mergeClass(mAll.value.trim(), 'm-');
    mergeClass(mx.value.trim(), 'mx-');
    mergeClass(my.value.trim(), 'my-');
    mergeClass(sizeW.value.trim(), 'w-');
    mergeClass(sizeH.value.trim(), 'h-');
    mergeClass(fontSize.value, 'text-');
    mergeClass(borderRadius.value, 'rounded');
    mergeClass(bgColor.value.trim(), 'bg-');
    
    // For text color, be careful not to conflict with text size prefix text-
    const tColor = textColor.value.trim();
    if (tColor) {
      classes = classes.filter(c => c.startsWith('text-') && ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl'].some(s => c.endsWith(s)) || !c.startsWith('text-'));
      classes.push(tColor);
    }

    const updatedClassName = classes.join(' ');
    const updatedInnerText = propText.value;

    vscode.postMessage({
      type: 'APPLY_VISUAL_CHANGES',
      payload: {
        filePath: activeSelection.filePath,
        lineNumber: activeSelection.lineNumber,
        columnNumber: activeSelection.columnNumber,
        className: updatedClassName,
        innerText: updatedInnerText
      }
    });

    // Update input fields to match new values
    propClasses.value = updatedClassName;
  });

  // 6. AI Assistant Queries
  btnAskAi.addEventListener('click', () => {
    const prompt = aiPrompt.value.trim();
    if (!prompt || !activeSelection) return;

    appendUserMessage(prompt);
    aiPrompt.value = '';

    vscode.postMessage({
      type: 'AI_MODIFY_REQUEST',
      payload: {
        prompt: prompt,
        filePath: activeSelection.filePath,
        lineNumber: activeSelection.lineNumber,
        columnNumber: activeSelection.columnNumber,
        scopeLock: scopeLock.checked
      }
    });
  });

  // AI Diff Actions
  btnDiffReject.addEventListener('click', () => {
    diffContainer.style.display = 'none';
    proposedAiDiff = null;
    appendSystemMessage('Changes discarded.');
  });

  btnDiffAccept.addEventListener('click', () => {
    if (!proposedAiDiff) return;

    vscode.postMessage({
      type: 'APPLY_AI_CHANGES',
      payload: {
        filePath: proposedAiDiff.filePath,
        content: proposedAiDiff.newContent
      }
    });

    diffContainer.style.display = 'none';
    proposedAiDiff = null;
    appendSystemMessage('Changes applied successfully!');
  });

  // Render proposed diff code
  function showDiff(diffMeta) {
    const relativePath = diffMeta.filePath.split('/').slice(-2).join('/');
    diffFilename.innerText = relativePath;

    // Render code diff lines
    diffCode.innerHTML = '';
    const diffLines = diffMeta.diff.split('\n');

    diffLines.forEach(line => {
      const lineSpan = document.createElement('span');
      lineSpan.innerText = line;
      if (line.startsWith('+')) {
        lineSpan.className = 'diff-line-add';
      } else if (line.startsWith('-')) {
        lineSpan.className = 'diff-line-del';
      }
      diffCode.appendChild(lineSpan);
      diffCode.appendChild(document.createTextNode('\n'));
    });

    diffContainer.style.display = 'flex';
    diffContainer.scrollIntoView({ behavior: 'smooth' });
  }

  // Chat Log Helpers
  function appendUserMessage(text) {
    const msg = document.createElement('div');
    msg.className = 'chat-message user';
    msg.innerText = text;
    chatHistory.appendChild(msg);
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }

  function appendSystemMessage(text) {
    const msg = document.createElement('div');
    msg.className = 'chat-message assistant';
    msg.innerText = text;
    chatHistory.appendChild(msg);
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }
})();
