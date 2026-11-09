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
        if (entity && Array.isArray(entity.sessionIds)) {
          return entity.sessionIds;
        }
      }
    } catch (_) {}
    return [];
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
          if (reg.sessionPaths && reg.sessionPaths.get) {
            const sessPath = reg.sessionPaths.get(sessionId);
            if (sessPath && hidden.path && path.normalize(sessPath).toLowerCase().startsWith(path.normalize(hidden.path).toLowerCase())) {
              return true;
            }
          }
        }
      }
    } catch (_) {}

    return false;
  }

  /**
   * 核心广播：严格通过 ctx.workspaceController.feed.baseline() 获取当前合法的工作区投影，
   * 并利用 feed.publish({ type: 'replace' }) 向前端实时广播，侧边栏瞬间响应。
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
   * 自动归拢游离会话：
   * 遍历所有历史会话，根据会话的工作目录（cwd）精准匹配所属工作区，
   * 将脱离工作区名录的游离会话正式绑定（attachSession）至正确的工作区下。
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
                  reg.host?.rememberSessionPath?.(header.id, header.cwd);
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
            return sendJson(res, 200, {
              hidden: hiddenList,
              available: allEntities.filter(e => !storedConfig.workspaces[e.id])
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

              const sessionIds = getSessionsForWorkspace(wsIdStr);
              for (const sId of sessionIds) {
                try { ctx.emit('api-session/removed', sId); } catch (_) {}
              }
              syncToClient();

              return sendJson(res, 200, { ok: true, message: 'Workspace shielded' });
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
              syncToClient();
              return sendJson(res, 200, { ok: true, message: 'Workspace summoned' });
            }
          }

          // POST /api/hidden-workspaces/reshide
          if (req.method === 'POST' && url.pathname === '/api/hidden-workspaces/reshide') {
            const { workspaceId } = await readJsonBody(req);
            if (workspaceId) {
              const wsIdStr = String(workspaceId);
              summonedIds.delete(wsIdStr);
              const sessionIds = getSessionsForWorkspace(wsIdStr);
              for (const sId of sessionIds) {
                try { ctx.emit('api-session/removed', sId); } catch (_) {}
              }
              syncToClient();
              return sendJson(res, 200, { ok: true, message: 'Workspace re-shielded' });
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
              syncToClient();
              return sendJson(res, 200, { ok: true, message: 'Workspace unhidden' });
            }
          }

          // POST /api/hidden-workspaces/sync
          if (req.method === 'POST' && url.pathname === '/api/hidden-workspaces/sync') {
            syncToClient();
            return sendJson(res, 200, { ok: true, message: 'Synced to client' });
          }

          // POST /api/hidden-workspaces/reconcile
          if (req.method === 'POST' && url.pathname === '/api/hidden-workspaces/reconcile') {
            const reconcileResult = await reconcileStraySessions();
            return sendJson(res, 200, { ok: true, message: 'Sessions reconciled', ...reconcileResult });
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
