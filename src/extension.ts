import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { ReactCanvasServer, ElementSelectionPayload } from './server';
import { updateElementClasses, updateElementText, generateLineDiff } from './ast-engine';

interface FileHistory {
  filePath: string;
  originalContent: string;
  undoStack: string[];
  redoStack: string[];
}

export function activate(context: vscode.ExtensionContext) {
  console.log('ReactCanvas AI Extension is now active.');

  let server: ReactCanvasServer | null = null;
  let activePanel: vscode.WebviewPanel | null = null;
  
  // History manager maps file paths to Undo/Redo lists
  const fileHistories = new Map<string, FileHistory>();
  let lastActiveFilePath: string | null = null;

  // Register command to open visual workspace
  let openCommand = vscode.commands.registerCommand('reactcanvas-ai.openEditor', () => {
    if (activePanel) {
      activePanel.reveal(vscode.ViewColumn.One);
      return;
    }

    activePanel = vscode.window.createWebviewPanel(
      'reactcanvasEditor',
      'ReactCanvas Live Editor',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview')),
          vscode.Uri.file(path.join(context.extensionPath, 'src', 'runtime'))
        ]
      }
    );

    // Load webview HTML content
    activePanel.webview.html = getWebviewHtml(context, activePanel.webview);

    // Setup extension message listener
    activePanel.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.type) {
          case 'CONNECT_DEV_SERVER': {
            const { devServerUrl } = message.payload;
            const config = vscode.workspace.getConfiguration('reactcanvas-ai');
            const proxyPort = config.get<number>('proxyPort') || 9900;

            if (server) {
              await server.stop();
            }

            server = new ReactCanvasServer(context);

            try {
              const actualPort = await server.start(devServerUrl, proxyPort);
              const currentPanel = activePanel;
              if (currentPanel) {
                currentPanel.webview.postMessage({
                  type: 'SERVER_CONNECTED',
                  payload: { proxyPort: actualPort }
                });
              }
            } catch (err: any) {
              const currentPanel = activePanel;
              if (currentPanel) {
                currentPanel.webview.postMessage({
                  type: 'SERVER_ERROR',
                  payload: { error: err.message || 'Port binding error' }
                });
              }
            }
            break;
          }

          case 'ELEMENT_SELECTED': {
            const payload = message.payload as ElementSelectionPayload;
            if (payload.filePath) {
              payload.filePath = resolveAbsolutePath(payload.filePath);
              lastActiveFilePath = payload.filePath;
              initHistoryTracker(payload.filePath);
            }
            
            // Forward it back to webview so that it is properly set
            const currentPanel = activePanel;
            if (currentPanel) {
              currentPanel.webview.postMessage({
                type: 'ELEMENT_SELECTED',
                payload
              });
              if (payload.filePath) {
                sendHistoryState(payload.filePath);
              }
            }
            break;
          }

          case 'TOGGLE_INSPECT_MODE':
            // Handled directly via postMessage bridge between webview and iframe
            break;

          case 'APPLY_VISUAL_CHANGES': {
            const { filePath, lineNumber, columnNumber, className, innerText } = message.payload;
            const resolvedPath = resolveAbsolutePath(filePath);
            lastActiveFilePath = resolvedPath;
            await applyVisualChanges(resolvedPath, lineNumber, columnNumber, className, innerText);
            break;
          }

          case 'AI_MODIFY_REQUEST': {
            const { prompt, filePath: file, lineNumber: line, columnNumber: col, scopeLock } = message.payload;
            const resolvedPath = resolveAbsolutePath(file);
            lastActiveFilePath = resolvedPath;
            const currentPanel = activePanel;
            if (currentPanel) {
              currentPanel.webview.postMessage({ type: 'AI_DIFF_GENERATING' });
            }
            await generateAIDiff(prompt, resolvedPath, line, col, scopeLock);
            break;
          }

          case 'APPLY_AI_CHANGES': {
            const resolvedPath = resolveAbsolutePath(message.payload.filePath);
            lastActiveFilePath = resolvedPath;
            await saveCodeChanges(resolvedPath, message.payload.content);
            break;
          }

          case 'UNDO':
            triggerHistoryAction('undo');
            break;

          case 'REDO':
            triggerHistoryAction('redo');
            break;

          case 'RESTORE':
            triggerHistoryAction('restore');
            break;
        }
      } catch (err: any) {
        console.error('Error handling message in extension host:', err);
        vscode.window.showErrorMessage(`ReactCanvas AI Error: ${err.message}`);
      }
    }, null, context.subscriptions);

    activePanel.onDidDispose(() => {
      activePanel = null;
      if (server) {
        server.stop();
        server = null;
      }
    }, null, context.subscriptions);
  });

  context.subscriptions.push(openCommand);

  // Helper to resolve absolute paths relative to workspace root if they are relative
  function resolveAbsolutePath(filePath: string): string {
    if (!filePath) return '';
    
    // Check if the path exists directly
    if (fs.existsSync(filePath)) {
      return filePath;
    }
    
    // If not, try to resolve it relative to the workspace root
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const rootPath = workspaceFolders[0].uri.fsPath;
      
      // Try joining directly
      let resolved = path.join(rootPath, filePath);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
      
      // If it starts with a slash (like /src/App.tsx), remove the leading slash and join
      if (filePath.startsWith('/')) {
        resolved = path.join(rootPath, filePath.substring(1));
        if (fs.existsSync(resolved)) {
          return resolved;
        }
      }
    }
    return filePath;
  }

  // Initialize history trackers
  function initHistoryTracker(filePath: string) {
    if (!filePath) return;
    if (!fileHistories.has(filePath) && fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      fileHistories.set(filePath, {
        filePath,
        originalContent: content,
        undoStack: [],
        redoStack: []
      });
    }
  }

  // Push new state onto undo list
  function saveStateToHistory(filePath: string, currentContent: string) {
    if (!filePath) return;
    const history = fileHistories.get(filePath);
    if (history) {
      history.undoStack.push(currentContent);
      history.redoStack = []; // Clear redo stack on new action
      sendHistoryState(filePath);
    }
  }

  // Send undo/redo/restore states back to Webview
  function sendHistoryState(filePath: string) {
    if (!filePath) return;
    const history = fileHistories.get(filePath);
    const currentPanel = activePanel;
    if (currentPanel && history) {
      currentPanel.webview.postMessage({
        type: 'HISTORY_STATE',
        payload: {
          canUndo: history.undoStack.length > 0,
          canRedo: history.redoStack.length > 0,
          canRestore: fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') !== history.originalContent
        }
      });
    }
  }

  // Execute undo/redo/restore action
  function triggerHistoryAction(action: 'undo' | 'redo' | 'restore') {
    // Work with the last active selected file or find first in map
    const activeFile = lastActiveFilePath || Array.from(fileHistories.keys()).pop();
    if (!activeFile) return;

    const history = fileHistories.get(activeFile);
    if (!history) return;

    try {
      const currentContent = fs.readFileSync(activeFile, 'utf8');

      if (action === 'undo' && history.undoStack.length > 0) {
        const previous = history.undoStack.pop()!;
        history.redoStack.push(currentContent);
        fs.writeFileSync(activeFile, previous, 'utf8');
      } else if (action === 'redo' && history.redoStack.length > 0) {
        const next = history.redoStack.pop()!;
        history.undoStack.push(currentContent);
        fs.writeFileSync(activeFile, next, 'utf8');
      } else if (action === 'restore') {
        history.undoStack.push(currentContent);
        history.redoStack = [];
        fs.writeFileSync(activeFile, history.originalContent, 'utf8');
      }

      sendHistoryState(activeFile);
    } catch (err: any) {
      vscode.window.showErrorMessage(`History navigation failed: ${err.message}`);
    }
  }

  // Apply visual editor changes (Tailwind + text) directly via AST Editing
  async function applyVisualChanges(
    filePath: string,
    line: number,
    column: number,
    className: string,
    innerText: string
  ) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const currentContent = fs.readFileSync(filePath, 'utf8');
    initHistoryTracker(filePath);
    saveStateToHistory(filePath, currentContent);

    try {
      let modifiedCode = currentContent;
      // Step A: Modify className in AST
      modifiedCode = updateElementClasses(modifiedCode, line, column, className);
      // Step B: Modify text children in AST
      modifiedCode = updateElementText(modifiedCode, line, column, innerText);

      fs.writeFileSync(filePath, modifiedCode, 'utf8');
      sendHistoryState(filePath);
    } catch (err) {
      // Revert history state on edit failure
      const history = fileHistories.get(filePath);
      if (history) history.undoStack.pop();
      throw err;
    }
  }

  // Saves AI diff outputs to disk
  async function saveCodeChanges(filePath: string, newContent: string) {
    if (!fs.existsSync(filePath)) return;
    const currentContent = fs.readFileSync(filePath, 'utf8');
    initHistoryTracker(filePath);
    saveStateToHistory(filePath, currentContent);
    fs.writeFileSync(filePath, newContent, 'utf8');
    sendHistoryState(filePath);
  }

  // Gather LLM API key and run visual change generation
  async function generateAIDiff(
    prompt: string,
    filePath: string,
    lineNumber: number,
    columnNumber: number,
    scopeLock: boolean
  ) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    const config = vscode.workspace.getConfiguration('reactcanvas-ai');
    
    // Attempt to gather keys
    const openaiKey = config.get<string>('openaiApiKey') || process.env.OPENAI_API_KEY;
    const anthropicKey = config.get<string>('anthropicApiKey') || process.env.ANTHROPIC_API_KEY;
    const geminiKey = config.get<string>('geminiApiKey') || process.env.GEMINI_API_KEY;

    let provider = '';
    let apiKey = '';
    let model = '';

    if (anthropicKey) {
      provider = 'anthropic';
      apiKey = anthropicKey;
      model = config.get<string>('anthropicModel') || 'claude-3-5-sonnet-20241022';
    } else if (geminiKey) {
      provider = 'gemini';
      apiKey = geminiKey;
      model = config.get<string>('geminiModel') || 'gemini-1.5-pro';
    } else if (openaiKey) {
      provider = 'openai';
      apiKey = openaiKey;
      model = config.get<string>('openaiModel') || 'gpt-4o';
    }

    if (!apiKey) {
      const currentPanel = activePanel;
      if (currentPanel) {
        currentPanel.webview.postMessage({
          type: 'AI_ERROR',
          payload: { error: 'No API Key configured. Please enter an API key for OpenAI, Anthropic, or Gemini in your VS Code settings.' }
        });
      }
      return;
    }

    const selectedFileContent = fs.readFileSync(filePath, 'utf8');
    
    // Gathers surrounding code contexts (AI Context Mode)
    let contextModeDescription = '';
    if (!scopeLock) {
      // Find other components in workspace (e.g. imports)
      const importLines = selectedFileContent.split('\n').filter(l => l.trim().startsWith('import '));
      contextModeDescription = `Workspace Component Context Imports:\n${importLines.join('\n')}`;
    }

    // Build the system instructions
    const systemPrompt = `You are a visual front-end engineering assistant.
You receive a React source file, target line numbers, and user instructions to edit the styles/structure of that target element using React & Tailwind CSS.

Return the COMPLETE updated file content. Do NOT include explanations, do NOT return Markdown blocks other than the code itself, do NOT use wrap blocks. Output only the full code so we can parse it directly.`;

    const userPrompt = `Target File: ${filePath}
Target JSX Line: ${lineNumber} (Col: ${columnNumber})
User Instructions: "${prompt}"

${contextModeDescription ? `---\n${contextModeDescription}\n` : ''}
---
Original File Content:
\`\`\`
${selectedFileContent}
\`\`\`

Rewrite the file and return only the full updated code.`;

    try {
      let rawResult = '';
      if (provider === 'openai') {
        rawResult = await callOpenAI(apiKey, model, systemPrompt, userPrompt);
      } else if (provider === 'anthropic') {
        rawResult = await callAnthropic(apiKey, model, systemPrompt, userPrompt);
      } else if (provider === 'gemini') {
        rawResult = await callGemini(apiKey, model, systemPrompt, userPrompt);
      }

      // Clean LLM markdown code blocks
      let cleanedContent = rawResult.trim();
      if (cleanedContent.startsWith('```')) {
        cleanedContent = cleanedContent.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
      }

      const diff = generateLineDiff(selectedFileContent, cleanedContent);

      const currentPanel = activePanel;
      if (currentPanel) {
        currentPanel.webview.postMessage({
          type: 'AI_DIFF_GENERATED',
          payload: {
            filePath,
            newContent: cleanedContent,
            diff
          }
        });
      }
    } catch (err: any) {
      const currentPanel = activePanel;
      if (currentPanel) {
        currentPanel.webview.postMessage({
          type: 'AI_ERROR',
          payload: { error: err.message || 'LLM call failed.' }
        });
      }
    }
  }
}

// 7. HTTPS API call wrapping
function callOpenAI(apiKey: string, model: string, system: string, user: string): Promise<string> {
  const postData = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.1
  });

  const options = {
    hostname: 'api.openai.com',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  return performHttpsRequest(options, postData).then(data => {
    const json = JSON.parse(data);
    return json.choices[0].message.content;
  });
}

function callAnthropic(apiKey: string, model: string, system: string, user: string): Promise<string> {
  const postData = JSON.stringify({
    model,
    max_tokens: 4000,
    system,
    messages: [
      { role: 'user', content: user }
    ],
    temperature: 0.1
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  return performHttpsRequest(options, postData).then(data => {
    const json = JSON.parse(data);
    return json.content[0].text;
  });
}

function callGemini(apiKey: string, model: string, system: string, user: string): Promise<string> {
  // Combine system prompt and user prompt for Gemini compatibility
  const combinedPrompt = `${system}\n\nUser Request:\n${user}`;
  const postData = JSON.stringify({
    contents: [{
      parts: [{ text: combinedPrompt }]
    }],
    generationConfig: {
      temperature: 0.1
    }
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  return performHttpsRequest(options, postData).then(data => {
    const json = JSON.parse(data);
    return json.candidates[0].content.parts[0].text;
  });
}

function performHttpsRequest(options: https.RequestOptions, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => responseBody += chunk);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(responseBody);
        } else {
          reject(new Error(`API Service Error: ${res.statusCode} ${responseBody}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(body);
    req.end();
  });
}



// Resolves webview resources dynamically
function getWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const htmlPath = path.join(context.extensionPath, 'src', 'webview', 'editor.html');
  let html = fs.readFileSync(htmlPath, 'utf8');

  // Load CSS file Uri
  const cssUri = webview.asWebviewUri(vscode.Uri.file(
    path.join(context.extensionPath, 'src', 'webview', 'editor.css')
  ));

  // Load JS file Uri
  const jsUri = webview.asWebviewUri(vscode.Uri.file(
    path.join(context.extensionPath, 'src', 'webview', 'editor.js')
  ));

  // Replace assets relative paths in HTML
  html = html.replace('href="editor.css"', `href="${cssUri}"`);
  html = html.replace('src="editor.js"', `src="${jsUri}"`);

  return html;
}

export function deactivate() {}
