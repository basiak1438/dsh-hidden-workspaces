import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const name = 'hidden-workspaces-host';
export const inject = [
  'workspaceRegistry',
  'workspaceController',
  'sessionController',
  'sessionPersistence',
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
  const sessionCwdMap = new Map(); // sessionId -> canonicalCwd

  async function refreshSessionCwdMap() {
    try {
      const persistence = ctx.sessionPersistence || ctx.get('sessionPersistence');
      if (persistence && typeof persistence.list === 'function') {
        const snapshots = await persistence.list();
        for (const snap of snapshots) {
          if (snap.header?.id && snap.header?.cwd) {
            sessionCwdMap.set(snap.header.id, snap.header.cwd);
          }
        }
      }
    } catch (err) {
      logger.error('Failed to refresh session cwd map:', err);
    }
  }

  // 初始化加载全量会话路径
  refreshSessionCwdMap();

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

  function getSessionsForWorkspace(workspaceId) {
    try {
      const reg = ctx.workspaceRegistry;
      if (reg) {
        const entity = reg.get ? reg.get(workspaceId) : (reg.entities?.get ? reg.entities.get(workspaceId) : null);
        const sIds = entity?.record?.sessionIds || entity?.sessionIds;
        if (Array.isArray(sIds)) {
          return sIds;
        }
      }
    } catch (_) {}
    return [];
  }

  function isSessionHidden(sessionId) {
    if (!sessionId) return false;
    const activeHidden = getActiveHiddenEntries();
    if (activeHidden.length === 0) return false;

    // 1. 检查工作区实体内记录的 sessionIds
    try {
      const reg = ctx.workspaceRegistry;
      if (reg) {
        for (const hidden of activeHidden) {
          const entity = reg.get ? reg.get(hidden.id) : (reg.entities?.get ? reg.entities.get(hidden.id) : null);
          const sIds = entity?.record?.sessionIds || entity?.sessionIds;
          if (Array.isArray(sIds) && sIds.includes(sessionId)) {
            return true;
          }
        }
      }
    } catch (_) {}

    // 2. 检查会话物理工作目录 (sessionCwdMap)
    const cwd = sessionCwdMap.get(sessionId);
    if (cwd) {
      const normCwd = path.normalize(cwd).toLowerCase();
      for (const hidden of activeHidden) {
        if (!hidden.path) continue;
        const normWsPath = path.normalize(hidden.path).toLowerCase();
        if (normCwd === normWsPath || normCwd.startsWith(normWsPath + path.sep)) {
          return true;
        }
      }
    }

    return false;
  }

  function getAllHiddenSessionIds() {
    const hiddenSet = new Set();
    const activeHidden = getActiveHiddenEntries();
    if (activeHidden.length === 0) return [];

    const reg = ctx.workspaceRegistry;
    for (const hidden of activeHidden) {
      const entity = reg?.get ? reg.get(hidden.id) : (reg?.entities?.get ? reg.entities.get(hidden.id) : null);
      const sIds = entity?.record?.sessionIds || entity?.sessionIds;
      if (Array.isArray(sIds)) {
        for (const id of sIds) hiddenSet.add(id);
      }
      if (hidden.path) {
        const normWsPath = path.normalize(hidden.path).toLowerCase();
        for (const [sId, cwd] of sessionCwdMap.entries()) {
          const normCwd = path.normalize(cwd).toLowerCase();
          if (normCwd === normWsPath || normCwd.startsWith(normWsPath + path.sep)) {
            hiddenSet.add(sId);
          }
        }
      }
    }
    return Array.from(hiddenSet);
  }

  /**
   * 核心广播：向连接的客户端同步最新工作区投影
   */
  function syncToClient() {
    try {
      const feed = ctx.workspaceController?.feed;
      if (feed && typeof feed.publish === 'function' && typeof feed.baseline === 'function') {
        const baseline = feed.baseline();
        feed.publish({ type: 'replace', value: baseline });
        feed.publish({
          type: 'order',
          workspaceIds: baseline.items.map(w => w.workspaceId)
        });
      }
    } catch (err) {
      logger.error('Failed to sync workspace feed to client:', err);
    }
  }

  /**
   * 自动归拢游离会话
   */
  async function reconcileStraySessions() {
    const result = { attached: 0, byWorkspace: {} };
    try {
      const reg = ctx.workspaceRegistry;
      const persistence = ctx.sessionPersistence || ctx.get('sessionPersistence');
      if (!reg || !reg.entities) return result;

      let headers = [];
      if (persistence && typeof persistence.list === 'function') {
        const snapshots = await persistence.list();
        headers = snapshots.map(s => s.header).filter(Boolean);
        for (const h of headers) {
          if (h.id && h.cwd) sessionCwdMap.set(h.id, h.cwd);
        }
      } else if (typeof reg.listStoredHeaders === 'function') {
        headers = await reg.listStoredHeaders();
      }

      if (headers.length === 0) return result;

      for (const entity of reg.entities.values()) {
        const wsId = String(entity.id);
        const wsPath = entity.path;
        if (!wsPath) continue;

        let canonicalWsPath = wsPath;
        try { canonicalWsPath = await fs.promises.realpath(wsPath); } catch (_) {}
        const normWsPath = path.normalize(canonicalWsPath).toLowerCase();

        const currentSessionIds = new Set(entity.record?.sessionIds || []);

        for (const header of headers) {
          if (!header.id || !header.cwd) continue;
          if (currentSessionIds.has(header.id)) continue;

          let canonicalCwd = header.cwd;
          try { canonicalCwd = await fs.promises.realpath(header.cwd); } catch (_) {}
          const normCwd = path.normalize(canonicalCwd).toLowerCase();

          if (normCwd === normWsPath || normCwd.startsWith(normWsPath + path.sep)) {
            try {
              await entity.attachSession(header.id);
              currentSessionIds.add(header.id);
              result.attached++;
              result.byWorkspace[entity.title || wsId] = (result.byWorkspace[entity.title || wsId] || 0) + 1;
            } catch (_) {
              try {
                const table = reg.requireTable ? reg.requireTable() : reg.table;
                if (table) {
                  await table.update(entity.id, (rec) => {
                    if (rec.sessionIds.includes(header.id)) return rec;
                    return { ...rec, sessionIds: [header.id, ...rec.sessionIds] };
                  });
                  currentSessionIds.add(header.id);
                  result.attached++;
                  result.byWorkspace[entity.title || wsId] = (result.byWorkspace[entity.title || wsId] || 0) + 1;
                }
              } catch (inner) {
                logger.warn(`Failed to attach session ${header.id} to ${wsId}:`, inner);
              }
            }
          }
        }
      }

      if (result.attached > 0) {
        syncToClient();
      }
    } catch (err) {
      logger.error('Error in reconcileStraySessions:', err);
    }
    return result;
  }

  // 1. 拦截检索与列表
  if (ctx.sessionController) {
    if (typeof ctx.sessionController.search === 'function') {
      const origSearch = ctx.sessionController.search;
      ctx.sessionController.search = async function(request, signal) {
        if (sessionCwdMap.size === 0) await refreshSessionCwdMap();
        const res = await origSearch.call(this, request, signal);
        if (res && Array.isArray(res.items)) {
          return { ...res, items: res.items.filter(item => !isSessionHidden(item.sessionId)) };
        }
        return res;
      };
      ctx.effect(() => () => {
        ctx.sessionController.search = origSearch;
      }, 'hidden-workspaces: restore sessionController.search');
    }
    if (typeof ctx.sessionController.list === 'function') {
      const origList = ctx.sessionController.list;
      ctx.sessionController.list = async function(request, signal) {
        if (sessionCwdMap.size === 0) await refreshSessionCwdMap();
        const res = await origList.call(this, request, signal);
        if (res && Array.isArray(res.items)) {
          return { ...res, items: res.items.filter(item => !isSessionHidden(item.sessionId)) };
        }
        return res;
      };
      ctx.effect(() => () => {
        ctx.sessionController.list = origList;
      }, 'hidden-workspaces: restore sessionController.list');
    }
  }

  // 2. 拦截工作区列表
  if (ctx.workspaceRegistry && typeof ctx.workspaceRegistry.list === 'function') {
    originalWorkspaceList = ctx.workspaceRegistry.list;
    ctx.workspaceRegistry.list = function() {
      const all = originalWorkspaceList.call(this);
      return all.filter(ws => !isEffectivelyHidden(String(ws.id), ws.path));
    };
    ctx.effect(() => () => {
      ctx.workspaceRegistry.list = originalWorkspaceList;
    }, 'hidden-workspaces: restore workspaceRegistry.list');
  }

  // 3. Agent 工具守卫
  if (ctx.tools && typeof ctx.tools.guard === 'function') {
    ctx.effect(() => ctx.tools.guard((exec) => {
      if (exec.name === 'session_event_search' || exec.name === 'session_event_read') {
        const targetId = exec.args?.session_id;
        if (targetId && isSessionHidden(targetId)) {
          return { kind: 'deny', reason: 'Session does not exist or is in a shielded workspace' };
        }
      }
      return undefined;
    }), 'hidden-workspaces: tool guard');
  }

  // 4. 注册 API 处理器
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

    if (ctx.webServer.prefixes && typeof ctx.webServer.prefixes.delete === 'function') {
      ctx.webServer.prefixes.delete('/api/hidden-workspaces');
    }

    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/hidden-workspaces',
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        try {
          // GET /api/hidden-workspaces/list
          if (req.method === 'GET' && url.pathname === '/api/hidden-workspaces/list') {
            if (sessionCwdMap.size === 0) await refreshSessionCwdMap();
            let allEntities = [];
            if (ctx.workspaceRegistry?.entities) {
              for (const entity of ctx.workspaceRegistry.entities.values()) {
                allEntities.push({
                  id: String(entity.id),
                  title: entity.title,
                  path: entity.path
                });
              }
            }
            if (allEntities.length === 0 && originalWorkspaceList && ctx.workspaceRegistry) {
              allEntities = originalWorkspaceList.call(ctx.workspaceRegistry).map(entity => ({
                id: String(entity.id),
                title: entity.title,
                path: entity.path
              }));
            }
            const hiddenList = Object.values(storedConfig.workspaces).map(w => ({
              id: w.id,
              title: w.title,
              path: w.path,
              hiddenAt: w.hiddenAt,
              isSummoned: summonedIds.has(w.id),
              hasPin: Boolean(w.pin)
            }));
            const activeHiddenWsIds = getActiveHiddenEntries().map(w => w.id);
            const hiddenSessionIds = getAllHiddenSessionIds();

            return sendJson(res, 200, {
              hidden: hiddenList,
              available: allEntities.filter(e => !storedConfig.workspaces[e.id]),
              activeHiddenWsIds,
              hiddenSessionIds
            });
          }

          // POST /api/hidden-workspaces/hide
          if (req.method === 'POST' && url.pathname === '/api/hidden-workspaces/hide') {
            const { workspaceId, pin } = await readJsonBody(req);
            if (workspaceId) {
              const wsIdStr = String(workspaceId);
              let entity = null;
              if (ctx.workspaceRegistry?.entities) {
                entity = ctx.workspaceRegistry.entities.get(wsIdStr);
              }
              if (!entity && ctx.workspaceRegistry?.get) {
                entity = ctx.workspaceRegistry.get(wsIdStr);
              }
              storedConfig.workspaces[wsIdStr] = {
                id: wsIdStr,
                title: entity?.title || wsIdStr,
                path: entity?.path || '',
                hiddenAt: new Date().toISOString(),
                pin: pin ? String(pin) : null
              };
              summonedIds.delete(wsIdStr);
              saveStoredConfig(storedConfig);

              await refreshSessionCwdMap();
              const sessionIds = getSessionsForWorkspace(wsIdStr);
              for (const sId of sessionIds) {
                try { ctx.emit('api-session/removed', sId); } catch (_) {}
              }
              syncToClient();

              return sendJson(res, 200, {
                ok: true,
                message: 'Workspace shielded',
                activeHiddenWsIds: getActiveHiddenEntries().map(w => w.id),
                hiddenSessionIds: getAllHiddenSessionIds()
              });
            }
          }

          // POST /api/hidden-workspaces/summon
          if (req.method === 'POST' && url.pathname === '/api/hidden-workspaces/summon') {
            const { workspaceId, pin } = await readJsonBody(req);
            if (workspaceId) {
              const wsIdStr = String(workspaceId);
              const entry = storedConfig.workspaces[wsIdStr];
              if (entry && entry.pin && entry.pin !== String(pin || '')) {
                return sendJson(res, 403, { error: 'Invalid PIN' });
              }
              summonedIds.add(wsIdStr);
              await refreshSessionCwdMap();
              syncToClient();
              return sendJson(res, 200, {
                ok: true,
                message: 'Workspace summoned',
                activeHiddenWsIds: getActiveHiddenEntries().map(w => w.id),
                hiddenSessionIds: getAllHiddenSessionIds()
              });
            }
          }

          // POST /api/hidden-workspaces/reshide
          if (req.method === 'POST' && url.pathname === '/api/hidden-workspaces/reshide') {
            const { workspaceId } = await readJsonBody(req);
            if (workspaceId) {
              const wsIdStr = String(workspaceId);
              summonedIds.delete(wsIdStr);
              await refreshSessionCwdMap();
              const sessionIds = getSessionsForWorkspace(wsIdStr);
              for (const sId of sessionIds) {
                try { ctx.emit('api-session/removed', sId); } catch (_) {}
              }
              syncToClient();
              return sendJson(res, 200, {
                ok: true,
                message: 'Workspace re-shielded',
                activeHiddenWsIds: getActiveHiddenEntries().map(w => w.id),
                hiddenSessionIds: getAllHiddenSessionIds()
              });
            }
          }

          // POST /api/hidden-workspaces/unhide
          if (req.method === 'POST' && url.pathname === '/api/hidden-workspaces/unhide') {
            const { workspaceId, pin } = await readJsonBody(req);
            if (workspaceId) {
              const wsIdStr = String(workspaceId);
              const entry = storedConfig.workspaces[wsIdStr];
              if (entry && entry.pin && entry.pin !== String(pin || '')) {
                return sendJson(res, 403, { error: 'Invalid PIN' });
              }
              delete storedConfig.workspaces[wsIdStr];
              summonedIds.delete(wsIdStr);
              saveStoredConfig(storedConfig);
              await refreshSessionCwdMap();
              syncToClient();
              return sendJson(res, 200, {
                ok: true,
                message: 'Workspace unhidden',
                activeHiddenWsIds: getActiveHiddenEntries().map(w => w.id),
                hiddenSessionIds: getAllHiddenSessionIds()
              });
            }
          }

          // POST /api/hidden-workspaces/sync
          if (req.method === 'POST' && url.pathname === '/api/hidden-workspaces/sync') {
            await refreshSessionCwdMap();
            syncToClient();
            return sendJson(res, 200, {
              ok: true,
              message: 'Synced to client',
              activeHiddenWsIds: getActiveHiddenEntries().map(w => w.id),
              hiddenSessionIds: getAllHiddenSessionIds()
            });
          }

          // POST /api/hidden-workspaces/reconcile
          if (req.method === 'POST' && url.pathname === '/api/hidden-workspaces/reconcile') {
            const reconcileResult = await reconcileStraySessions();
            return sendJson(res, 200, {
              ok: true,
              message: 'Sessions reconciled',
              ...reconcileResult,
              activeHiddenWsIds: getActiveHiddenEntries().map(w => w.id),
              hiddenSessionIds: getAllHiddenSessionIds()
            });
          }

          sendJson(res, 404, { error: 'Not found' });
        } catch (err) {
          logger.error('API Error:', err);
          sendJson(res, 500, { error: err.message });
        }
      }
    }), 'hidden-workspaces: web route /api/hidden-workspaces');
  }

  // 5. 注册管理命令
  if (ctx.commands && typeof ctx.commands.register === 'function') {
    ctx.effect(() => ctx.commands.register({
      name: 'summon-workspaces',
      description: '手动唤出所有已隐匿的工作区',
      async handler() {
        const count = Object.keys(storedConfig.workspaces).length;
        for (const id of Object.keys(storedConfig.workspaces)) {
          summonedIds.add(id);
        }
        syncToClient();
        return { kind: 'success', text: `已手动唤出 ${count} 个隐匿工作区。` };
      }
    }), 'hidden-workspaces: command summon-workspaces');

    ctx.effect(() => ctx.commands.register({
      name: 'reshide-workspaces',
      description: '立即重新隐匿所有已唤出的工作区',
      async handler() {
        summonedIds.clear();
        syncToClient();
        return { kind: 'success', text: '已重新隐匿所有隐私工作区，检索与视图已完全隔离。' };
      }
    }), 'hidden-workspaces: command reshide-workspaces');
  }
}
export default { name, inject, apply };
