import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';

export interface ElementSelectionPayload {
  tagName: string;
  componentName: string;
  innerText: string;
  classList: string[];
  className: string;
  filePath: string;
  lineNumber: number;
  columnNumber: number;
  hierarchy: Array<{
    name: string;
    filePath: string;
    lineNumber: number;
    columnNumber: number;
  }>;
}

/**
 * Helper to find an available port recursively starting from the given port.
 */
function getFreePort(startingPort: number): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      resolve(getFreePort(startingPort + 1));
    });
    server.listen(startingPort, () => {
      server.close(() => {
        resolve(startingPort);
      });
    });
  });
}

export class ReactCanvasServer {
  private proxyServer: http.Server | null = null;
  private extensionContext: any; // VS Code extension context

  constructor(context: any) {
    this.extensionContext = context;
  }

  /**
   * Starts the proxy server.
   * Resolves with the actual port bound.
   */
  public start(devServerUrl: string, proxyPort: number): Promise<number> {
    return new Promise(async (resolve, reject) => {
      try {
        const targetUrl = new URL(devServerUrl);
        const targetHost = targetUrl.hostname || 'localhost';
        
        const targetPort = parseInt(targetUrl.port) || (targetUrl.protocol === 'https:' ? 443 : 80);

        // Find a free port starting from proxyPort
        const actualPort = await getFreePort(proxyPort);

        // Start HTTP Proxy Server
        this.proxyServer = http.createServer((clientReq, clientRes) => {
          // Serve the inspector script if requested
          if (clientReq.url && (clientReq.url.startsWith('/reactcanvas_inspector.js') || clientReq.url.startsWith('/__reactcanvas_inspector.js'))) {
            // Find path of inspector.js in extension directory
            const inspectorPath = path.join(this.extensionContext.extensionPath, 'src', 'runtime', 'inspector.js');
            fs.readFile(inspectorPath, 'utf8', (err, content) => {
              if (err) {
                clientRes.writeHead(500, { 'Content-Type': 'text/plain' });
                clientRes.end('Error loading inspector script');
                return;
              }
              clientRes.writeHead(200, { 
                'Content-Type': 'application/javascript',
                'Access-Control-Allow-Origin': '*'
              });
              clientRes.end(content);
            });
            return;
          }

          // Forward ordinary HTTP requests to the developer server
          const headers = { ...clientReq.headers };
          headers['host'] = `${targetHost}:${targetPort}`;
          
          // Disable compression (gzip/deflate) to easily process raw HTML as plain text
          headers['accept-encoding'] = 'identity';

          const proxyReq = http.request({
            host: targetHost,
            port: targetPort,
            path: clientReq.url,
            method: clientReq.method,
            headers: headers
          }, (proxyRes) => {
            const contentType = proxyRes.headers['content-type'] || '';

            if (contentType.includes('text/html')) {
              // Intercept HTML file and inject the inspector script tag before </body>
              let body = '';
              proxyRes.on('data', (chunk) => {
                body += chunk.toString();
              });
              proxyRes.on('end', () => {
                const scriptTag = `<script src="/reactcanvas_inspector.js"></script>`;
                let modifiedBody = body;
                if (body.includes('</body>')) {
                  modifiedBody = body.replace('</body>', `${scriptTag}</body>`);
                } else if (body.includes('</html')) {
                  modifiedBody = body.replace('</html>', `${scriptTag}</html>`);
                } else {
                  modifiedBody = body + scriptTag;
                }
                
                // Content-Length header needs update to match modified body size
                const newHeaders = { ...proxyRes.headers };
                newHeaders['content-length'] = Buffer.byteLength(modifiedBody).toString();
                
                clientRes.writeHead(proxyRes.statusCode || 200, newHeaders);
                clientRes.end(modifiedBody);
              });
            } else {
              // Pipe all other requests (JS, CSS, PNG, SVG) straight to client
              clientRes.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
              proxyRes.pipe(clientRes);
            }
          });

          proxyReq.on('error', (err) => {
            console.error('[ReactCanvas Server] Proxy connection error to React Dev Server:', err);
            clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
            clientRes.end(`Dev server at ${devServerUrl} is unreachable. Ensure the app is running.`);
          });

          // Forward client request body (e.g. POST payload) to dev server
          clientReq.pipe(proxyReq);
        });

        // Setup TCP Tunnel for Websocket HMR connections
        this.proxyServer.on('upgrade', (req, socket, head) => {
          console.log(`[ReactCanvas Server] Proxying HMR WS upgrade for: ${req.url}`);
          
          const clientSocket = net.connect(targetPort, targetHost, () => {
            // Reconstruct HTTP upgrade request header bytes
            let rawHeaders = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
              rawHeaders += `${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}\r\n`;
            }
            rawHeaders += '\r\n';
            
            clientSocket.write(rawHeaders);
            if (head && head.length > 0) {
              clientSocket.write(head);
            }
            
            // Link sockets
            socket.pipe(clientSocket);
            clientSocket.pipe(socket);
          });

          clientSocket.on('error', (err) => {
            console.error('[ReactCanvas Server] HMR Proxy WS Connection error:', err);
            socket.destroy();
          });

          socket.on('error', (err) => {
            console.error('[ReactCanvas Server] HMR Proxy Client socket error:', err);
            clientSocket.destroy();
          });
        });

        // Start listening
        this.proxyServer.listen(actualPort, () => {
          console.log(`[ReactCanvas Server] Proxy server listening on port ${actualPort}`);
          resolve(actualPort);
        });

        this.proxyServer.on('error', (err) => {
          reject(err);
        });

      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stops the active server proxy.
   */
  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.proxyServer) {
        this.proxyServer.close(() => {
          this.proxyServer = null;
          console.log('[ReactCanvas Server] Proxy server stopped successfully.');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
