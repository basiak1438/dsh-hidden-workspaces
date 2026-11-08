import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const name = 'hidden-workspaces-host';
export const inject = [
  'workspaceRegistry',
  'workspaceController',
  'sessionController',
  'webServer',
  'commands',
  'tools'
];

export function apply(ctx) {
  const logger = ctx.logger ? ctx.logger('hidden-workspaces') : console;

  const configDir = path.join(os.homedir(), '.dsh');
  const configPath = path.join(configDir, 'hidden_workspaces.json');

  function loadStoredConfig() {
    try {
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      logger.error('Failed to load hidden workspaces config:', err);
    }
    return { workspaces: {} };
  }

  function saveStoredConfig(data) {
    try {
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      logger.error('Failed to save hidden workspaces config:', err);
    }
  }

  let storedConfig = loadStoredConfig();
  let originalWorkspaceList = null;
  const summonedIds = new Set();

  function isEffectivelyHidden(workspaceId, workspacePath) {
    const wsIdStr = String(workspaceId);
    const entry = storedConfig.workspaces[wsIdStr] ||
      Object.values(storedConfig.workspaces).find(w => w.path && workspacePath && path.normalize(w.path).toLowerCase() === path.normalize(workspacePath).toLowerCase());
    
    if (!entry) return false;
    if (summonedIds.has(entry.id)) return false;
    return true;
  }

  function getActiveHiddenEntries() {
    return Object.values(storedConfig.workspaces).filter(w => !summonedIds.has(w.id));
  }

  function isSessionHidden(sessionId) {
    if (!sessionId) return false;
    const activeHidden = getActiveHiddenEntries();
    if (activeHidden.length === 0) return false;

    try {
      const reg = ctx.workspaceRegistry;
      if (reg) {
        for (const hidden of activeHidden) {
          const entity = reg.get ? reg.get(hidden.id) : (reg.entities?.get ? reg.entities.get(hidden.id) : null);
          if (entity && Array.isArray(entity.sessionIds) && entity.sessionIds.includes(sessionId)) {
            return true;
          }
        }
      }
    } catch (_) {}

    return false;
  }

  // 1. 拦截检索与列表
  if (ctx.sessionController) {
    if (typeof ctx.sessionController.search === 'function') {
      const origSearch = ctx.sessionController.search;
      ctx.sessionController.search = async function(request, signal) {
        const res = await origSearch.call(this, request, signal);
        if (res && Array.isArray(res.items)) {
          return { ...res, items: res.items.filter(item => !isSessionHidden(item.sessionId)) };
        }
        return res;
      };
    }
    if (typeof ctx.sessionController.list === 'function') {
      const origList = ctx.sessionController.list;
      ctx.sessionController.list = async function(request, signal) {
        const res = await origList.call(this, request, signal);
        if (res && Array.isArray(res.items)) {
          return { ...res, items: res.items.filter(item => !isSessionHidden(item.sessionId)) };
        }
        return res;
      };
    }
  }

  if (ctx.workspaceRegistry && typeof ctx.workspaceRegistry.list === 'function') {
    originalWorkspaceList = ctx.workspaceRegistry.list;
    ctx.workspaceRegistry.list = function() {
      const all = originalWorkspaceList.call(this);
      return all.filter(ws => !isEffectivelyHidden(String(ws.id), ws.path));
    };
  }

  if (ctx.workspaceController && typeof ctx.workspaceController.baseline === 'function') {
    const origBaseline = ctx.workspaceController.baseline;
    ctx.workspaceController.baseline = function() {
      const base = origBaseline.call(this);
      if (base && Array.isArray(base.items)) {
        return {
          ...base,
          items: base.items.filter(item => !isEffectivelyHidden(String(item.workspaceId), item.path))
        };
      }
      return base;
    };
  }

  // 2. 注册 API 处理器
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    function readJsonBody(req) {
      return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { resolve({}); }
        });
        req.on('error', () => resolve({}));
      });
    }

    function sendJson(res, statusCode, data) {
      res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    }

    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/hidden-workspaces',
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        try {
          // List
          if (req.method === 'GET' && url.pathname === '/api/hidden-workspaces/list') {
            let allEntities = [];
            if (originalWorkspaceList) {
              allEntities = originalWorkspaceList.call(ctx.workspaceRegistry).map(entity => ({
                id: String(entity.id),
                title: entity.title,
                path: entity.path
              }));
            }
            const hiddenList = Object.values(storedConfig.workspaces).map(w => ({
              id: w.id, title: w.title, path: w.path, isSummoned: summonedIds.has(w.id)
            }));
            return sendJson(res, 200, { hidden: hiddenList, available: allEntities.filter(e => !storedConfig.workspaces[e.id]) });
          }

          // Hide
          if (req.method === 'POST' && url.pathname === '/api/hidden-workspaces/hide') {
            const { workspaceId } = await readJsonBody(req);
            if (workspaceId) {
              const entity = originalWorkspaceList.call(ctx.workspaceRegistry).find(w => w.id === workspaceId);
              storedConfig.workspaces[workspaceId] = { id: workspaceId, title: entity?.title || workspaceId, path: entity?.path || '' };
              saveStoredConfig(storedConfig);
              return sendJson(res, 200, { ok: true });
            }
          }

          // Summon
          if (req.method === 'POST' && url.pathname === '/api/hidden-workspaces/summon') {
            const { workspaceId } = await readJsonBody(req);
            if (workspaceId) {
              summonedIds.add(workspaceId);
              return sendJson(res, 200, { ok: true });
            }
          }

          // Unhide
          if (req.method === 'POST' && url.pathname === '/api/hidden-workspaces/unhide') {
            const { workspaceId } = await readJsonBody(req);
            if (workspaceId) {
              delete storedConfig.workspaces[workspaceId];
              summonedIds.delete(workspaceId);
              saveStoredConfig(storedConfig);
              return sendJson(res, 200, { ok: true });
            }
          }

          sendJson(res, 404, { error: 'Not found' });
        } catch (err) {
          sendJson(res, 500, { error: err.message });
        }
      }
    });
  }
}
export default { name, inject, apply };
