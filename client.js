window.__ModuleLoader__.load({
  id: '@local/dsh-hidden-workspaces',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // 矢量图标：隐蔽之眼 / 隔离锁
    function ShieldEyeIcon(props) {
      const size = props?.size || 16;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: { verticalAlign: 'middle', flexShrink: 0 }
      }, [
        h('path', { key: 'p1', d: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24' }),
        h('line', { key: 'l1', x1: 1, y1: 1, x2: 23, y2: 23 })
      ]);
    }

    // 侧边栏底部唤出按钮
    function SidebarTriggerButton() {
      return h('button', {
        type: 'button',
        title: '工作区隐身与检索管理 (Ctrl+Shift+H)',
        'aria-label': '工作区隐身与检索管理',
        onClick: () => {
          window.dispatchEvent(new CustomEvent('dsh:toggle-hidden-workspaces'));
        },
        style: {
          width: '28px',
          height: '28px',
          border: 'none',
          background: 'transparent',
          borderRadius: 'var(--dsw-radius-sm, 4px)',
          color: 'var(--dsw-alias-label-secondary, #9aa0a6)',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          transition: 'all 0.15s ease'
        },
        onMouseEnter: (e) => {
          e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08))';
          e.currentTarget.style.color = 'var(--dsw-alias-label-primary, #ffffff)';
        },
        onMouseLeave: (e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--dsw-alias-label-secondary, #9aa0a6)';
        }
      }, h(ShieldEyeIcon, { size: 16 }));
    }

    // 主管理弹窗组件（注册在 shell.overlay）
    function HiddenWorkspacesManagerModal() {
      const [isOpen, setIsOpen] = React.useState(false);
      const [loading, setLoading] = React.useState(false);
      const [data, setData] = React.useState({ hidden: [], available: [] });
      const [selectedWsId, setSelectedWsId] = React.useState('');
      const [pinDraft, setPinDraft] = React.useState('');
      const [promptPinWsId, setPromptPinWsId] = React.useState(null);
      const [inputPin, setInputPin] = React.useState('');
      const [message, setMessage] = React.useState(null);

      // 加载数据
      const fetchData = React.useCallback(async () => {
        setLoading(true);
        try {
          const res = await fetch('/api/hidden-workspaces/list');
          if (res.ok) {
            const json = await res.json();
            setData(json);
            if (json.available && json.available.length > 0) {
              setSelectedWsId(json.available[0].id);
            } else {
              setSelectedWsId('');
            }
          }
        } catch (err) {
          console.error('[hidden-workspaces] Fetch list failed:', err);
        } finally {
          setLoading(false);
        }
      }, []);

      // 监听全局触发与快捷键
      React.useEffect(() => {
        const handleToggle = () => {
          setIsOpen((prev) => {
            const next = !prev;
            if (next) fetchData();
            return next;
          });
          setMessage(null);
        };

        const handleKeyDown = (e) => {
          if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'h') {
            e.preventDefault();
            handleToggle();
          } else if (e.key === 'Escape' && isOpen) {
            setIsOpen(false);
          }
        };

        window.addEventListener('dsh:toggle-hidden-workspaces', handleToggle);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
          window.removeEventListener('dsh:toggle-hidden-workspaces', handleToggle);
          window.removeEventListener('keydown', handleKeyDown);
        };
      }, [isOpen, fetchData]);

      if (!isOpen) return null;

      // 隐藏工作区
      const handleHide = async () => {
        if (!selectedWsId) return;
        setLoading(true);
        setMessage(null);
        try {
          const res = await fetch('/api/hidden-workspaces/hide', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: selectedWsId, pin: pinDraft.trim() || undefined })
          });
          if (res.ok) {
            setPinDraft('');
            setMessage({ type: 'success', text: '工作区已成功隐匿！检索与侧边栏已全面隔离。' });
            await fetchData();
          } else {
            const err = await res.json();
            setMessage({ type: 'error', text: err.error || '隐匿失败' });
          }
        } catch (err) {
          setMessage({ type: 'error', text: '请求失败: ' + err.message });
        } finally {
          setLoading(false);
        }
      };

      // 手动唤出
      const handleSummon = async (wsId, pin) => {
        setLoading(true);
        setMessage(null);
        try {
          const res = await fetch('/api/hidden-workspaces/summon', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: wsId, pin })
          });
          if (res.ok) {
            setPromptPinWsId(null);
            setInputPin('');
            setMessage({ type: 'success', text: '已手动唤出！该工作区已临时解除隔离。' });
            await fetchData();
          } else {
            const err = await res.json();
            setMessage({ type: 'error', text: err.error || '口令错误或唤出失败' });
          }
        } catch (err) {
          setMessage({ type: 'error', text: '请求失败: ' + err.message });
        } finally {
          setLoading(false);
        }
      };

      // 重新隐匿
      const handleReshide = async (wsId) => {
        setLoading(true);
        setMessage(null);
        try {
          const res = await fetch('/api/hidden-workspaces/reshide', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: wsId })
          });
          if (res.ok) {
            setMessage({ type: 'success', text: '已重新隐匿并生效隔离。' });
            await fetchData();
          }
        } catch (err) {
          setMessage({ type: 'error', text: '操作失败: ' + err.message });
        } finally {
          setLoading(false);
        }
      };

      // 彻底取消隐匿
      const handleUnhide = async (wsId, pin) => {
        setLoading(true);
        setMessage(null);
        try {
          const res = await fetch('/api/hidden-workspaces/unhide', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: wsId, pin })
          });
          if (res.ok) {
            setPromptPinWsId(null);
            setInputPin('');
            setMessage({ type: 'success', text: '已彻底解除隐匿，恢复为普通工作区。' });
            await fetchData();
          } else {
            const err = await res.json();
            setMessage({ type: 'error', text: err.error || '口令错误或解除失败' });
          }
        } catch (err) {
          setMessage({ type: 'error', text: '操作失败: ' + err.message });
        } finally {
          setLoading(false);
        }
      };

      // 弹窗视图渲染
      return h('div', {
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(0, 0, 0, 0.65)',
          backdropFilter: 'blur(4px)',
          fontFamily: 'inherit'
        },
        onClick: (e) => {
          if (e.target === e.currentTarget) setIsOpen(false);
        }
      }, [
        h('div', {
          key: 'modal-card',
          style: {
            width: '640px',
            maxWidth: '92vw',
            maxHeight: '86vh',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: 'var(--dsw-alias-surface-elevated, #1e1f22)',
            color: 'var(--dsw-alias-label-primary, #ffffff)',
            borderRadius: 'var(--dsw-radius-lg, 12px)',
            border: '1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,0.12))',
            boxShadow: '0 12px 36px rgba(0,0,0,0.45)',
            overflow: 'hidden'
          }
        }, [
          // 弹窗头部
          h('div', {
            key: 'header',
            style: {
              padding: '16px 20px',
              borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,0.08))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }
          }, [
            h('div', { key: 'title-group', style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
              h(ShieldEyeIcon, { size: 20 }),
              h('span', { style: { fontSize: '16px', fontWeight: 600 } }, '工作区隐身与检索隔离管理器')
            ]),
            h('button', {
              key: 'close-btn',
              type: 'button',
              onClick: () => setIsOpen(false),
              style: {
                background: 'transparent',
                border: 'none',
                color: 'var(--dsw-alias-label-secondary, #9aa0a6)',
                cursor: 'pointer',
                fontSize: '18px',
                padding: '4px 8px',
                borderRadius: '4px'
              }
            }, '✕')
          ]),

          // 弹窗主体内容
          h('div', {
            key: 'body',
            style: {
              padding: '20px',
              overflowY: 'auto',
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: '20px'
            }
          }, [
            // 隔离准则提示卡片
            h('div', {
              key: 'notice-banner',
              style: {
                padding: '12px 14px',
                borderRadius: 'var(--dsw-radius-md, 8px)',
                backgroundColor: 'rgba(37, 99, 235, 0.12)',
                border: '1px solid rgba(37, 99, 235, 0.28)',
                color: '#93c5fd',
                fontSize: '13px',
                lineHeight: '1.5'
              }
            }, '🛡️ 保护机制：处于隐匿状态的工作区及其全部会话，已在全局会话搜索、侧边栏列表、及智能体历史中完全脱敏隔离。未在下方手动唤出前，DSH 绝不检索其中任何内容。'),

            // 状态反馈提示
            message && h('div', {
              key: 'msg-banner',
              style: {
                padding: '10px 14px',
                borderRadius: '6px',
                fontSize: '13px',
                backgroundColor: message.type === 'success' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                color: message.type === 'success' ? '#6ee7b7' : '#fca5a5',
                border: `1px solid ${message.type === 'success' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`
              }
            }, message.text),

            // 板块 1：快速隐匿现有工作区
            h('div', {
              key: 'sec-hide-new',
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                padding: '14px',
                borderRadius: 'var(--dsw-radius-md, 8px)',
                backgroundColor: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.04))'
              }
            }, [
              h('div', { style: { fontWeight: 600, fontSize: '14px' } }, '➕ 隐匿指定工作区'),
              h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } }, [
                h('select', {
                  key: 'select-ws',
                  value: selectedWsId,
                  onChange: (e) => setSelectedWsId(e.target.value),
                  disabled: loading || data.available.length === 0,
                  style: {
                    flex: '1 1 200px',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    background: 'var(--dsw-alias-surface-elevated, #2a2b2f)',
                    color: 'var(--dsw-alias-label-primary, #fff)',
                    border: '1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,0.15))',
                    fontSize: '13px'
                  }
                }, data.available.length === 0
                  ? [h('option', { key: 'none', value: '' }, '暂无可隐匿的工作区')]
                  : data.available.map((ws) => h('option', { key: ws.id, value: ws.id }, `${ws.title} (${ws.path})`))
                ),
                h('input', {
                  key: 'pin-input',
                  type: 'password',
                  placeholder: '可选口令 (PIN)',
                  value: pinDraft,
                  onChange: (e) => setPinDraft(e.target.value),
                  disabled: loading || data.available.length === 0,
                  style: {
                    width: '130px',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    background: 'var(--dsw-alias-surface-elevated, #2a2b2f)',
                    color: 'var(--dsw-alias-label-primary, #fff)',
                    border: '1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,0.15))',
                    fontSize: '13px'
                  }
                }),
                h('button', {
                  key: 'btn-hide',
                  type: 'button',
                  onClick: handleHide,
                  disabled: loading || !selectedWsId,
                  style: {
                    padding: '8px 16px',
                    borderRadius: '6px',
                    backgroundColor: '#2563eb',
                    color: '#ffffff',
                    border: 'none',
                    fontWeight: 500,
                    cursor: (!loading && selectedWsId) ? 'pointer' : 'not-allowed',
                    opacity: (!loading && selectedWsId) ? 1 : 0.6,
                    fontSize: '13px'
                  }
                }, '一键隐匿')
              ])
            ]),

            // 板块 2：已隐匿工作区清单
            h('div', { key: 'sec-hidden-list', style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, [
              h('div', { style: { fontWeight: 600, fontSize: '14px', display: 'flex', justifyContent: 'space-between' } }, [
                h('span', null, `🔒 已隐匿工作区 (${data.hidden.length})`),
                h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #9aa0a6)' } }, '快捷键：Ctrl+Shift+H 随时唤出')
              ]),

              data.hidden.length === 0
                ? h('div', {
                    style: {
                      padding: '24px',
                      textAlign: 'center',
                      color: 'var(--dsw-alias-label-secondary, #9aa0a6)',
                      fontSize: '13px'
                    }
                  }, '当前暂无隐匿的工作区。')
                : h('div', {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px'
                    }
                  }, data.hidden.map((ws) => {
                    const isSummoned = ws.isSummoned;
                    const isAskingPin = promptPinWsId === ws.id;

                    return h('div', {
                      key: ws.id,
                      style: {
                        padding: '12px 14px',
                        borderRadius: 'var(--dsw-radius-md, 8px)',
                        border: '1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,0.08))',
                        background: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.02))',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px'
                      }
                    }, [
                      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
                          h('span', { style: { fontWeight: 600, fontSize: '14px' } }, ws.title),
                          ws.hasPin && h('span', {
                            style: {
                              fontSize: '11px',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: 'rgba(234, 179, 8, 0.15)',
                              color: '#facc15'
                            }
                          }, '口令保护'),
                          h('span', {
                            style: {
                              fontSize: '11px',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: isSummoned ? 'rgba(16, 185, 129, 0.15)' : 'rgba(59, 130, 246, 0.15)',
                              color: isSummoned ? '#34d399' : '#60a5fa'
                            }
                          }, isSummoned ? '🔓 已手动唤出' : '🛡️ 已全面隔离')
                        ]),

                        // 操作按钮组
                        h('div', { style: { display: 'flex', gap: '6px' } }, [
                          !isSummoned
                            ? h('button', {
                                key: 'summon-btn',
                                type: 'button',
                                onClick: () => {
                                  if (ws.hasPin) {
                                    setPromptPinWsId(ws.id);
                                    setInputPin('');
                                  } else {
                                    handleSummon(ws.id);
                                  }
                                },
                                style: {
                                  padding: '4px 10px',
                                  borderRadius: '4px',
                                  background: '#2563eb',
                                  color: '#fff',
                                  border: 'none',
                                  fontSize: '12px',
                                  cursor: 'pointer'
                                }
                              }, '手动唤出')
                            : h('button', {
                                key: 'reshide-btn',
                                type: 'button',
                                onClick: () => handleReshide(ws.id),
                                style: {
                                  padding: '4px 10px',
                                  borderRadius: '4px',
                                  background: '#4b5563',
                                  color: '#fff',
                                  border: 'none',
                                  fontSize: '12px',
                                  cursor: 'pointer'
                                }
                              }, '重新隐匿'),
                          h('button', {
                            key: 'unhide-btn',
                            type: 'button',
                            onClick: () => {
                              if (ws.hasPin) {
                                setPromptPinWsId(ws.id);
                                setInputPin('');
                              } else {
                                handleUnhide(ws.id);
                              }
                            },
                            style: {
                              padding: '4px 10px',
                              borderRadius: '4px',
                              background: 'transparent',
                              border: '1px solid rgba(239, 68, 68, 0.4)',
                              color: '#f87171',
                              fontSize: '12px',
                              cursor: 'pointer'
                            }
                          }, '解除隐匿')
                        ])
                      ]),

                      h('div', {
                        style: {
                          fontSize: '12px',
                          color: 'var(--dsw-alias-label-secondary, #9aa0a6)',
                          wordBreak: 'break-all'
                        }
                      }, ws.path),

                      // 口令输入行
                      isAskingPin && h('div', {
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          marginTop: '6px',
                          padding: '8px',
                          borderRadius: '4px',
                          background: 'rgba(0,0,0,0.2)'
                        }
                      }, [
                        h('input', {
                          type: 'password',
                          placeholder: '请输入口令 (PIN)',
                          value: inputPin,
                          autoFocus: true,
                          onChange: (e) => setInputPin(e.target.value),
                          style: {
                            flex: 1,
                            padding: '6px 10px',
                            borderRadius: '4px',
                            background: '#2a2b2f',
                            color: '#fff',
                            border: '1px solid rgba(255,255,255,0.2)',
                            fontSize: '12px'
                          }
                        }),
                        h('button', {
                          type: 'button',
                          onClick: () => {
                            if (!isSummoned) {
                              handleSummon(ws.id, inputPin);
                            } else {
                              handleUnhide(ws.id, inputPin);
                            }
                          },
                          style: {
                            padding: '6px 12px',
                            borderRadius: '4px',
                            background: '#2563eb',
                            color: '#fff',
                            border: 'none',
                            fontSize: '12px',
                            cursor: 'pointer'
                          }
                        }, '确认'),
                        h('button', {
                          type: 'button',
                          onClick: () => setPromptPinWsId(null),
                          style: {
                            padding: '6px 10px',
                            borderRadius: '4px',
                            background: 'transparent',
                            color: '#9aa0a6',
                            border: 'none',
                            fontSize: '12px',
                            cursor: 'pointer'
                          }
                        }, '取消')
                      ])
                    ]);
                  }))
            ])
          ]),

          // 弹窗底部工具条
          h('div', {
            key: 'footer',
            style: {
              padding: '14px 20px',
              borderTop: '1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,0.08))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: 'rgba(0,0,0,0.1)'
            }
          }, [
            h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #9aa0a6)' } }, '唤出或隐匿后，建议刷新页面以即时同步侧边栏与索引树'),
            h('div', { style: { display: 'flex', gap: '10px' } }, [
              h('button', {
                key: 'refresh-view-btn',
                type: 'button',
                onClick: () => window.location.reload(),
                style: {
                  padding: '6px 14px',
                  borderRadius: '6px',
                  background: 'transparent',
                  border: '1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,0.2))',
                  color: 'var(--dsw-alias-label-primary, #ffffff)',
                  fontSize: '13px',
                  cursor: 'pointer'
                }
              }, '🔄 刷新视图'),
              h('button', {
                key: 'done-btn',
                type: 'button',
                onClick: () => setIsOpen(false),
                style: {
                  padding: '6px 16px',
                  borderRadius: '6px',
                  background: '#2563eb',
                  border: 'none',
                  color: '#ffffff',
                  fontWeight: 500,
                  fontSize: '13px',
                  cursor: 'pointer'
                }
              }, '完成')
            ])
          ])
        ])
      ]);
    }

    // 导出 Cordis Client Half 插件
    return {
      inject: ['slots'],
      apply(ctx) {
        // 1. 注册侧边栏底部唤出按钮
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'hidden-workspaces-trigger',
          order: 50
        }, SidebarTriggerButton));

        // 2. 注册全屏浮层管理弹窗
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'hidden-workspaces-manager-overlay'
        }, HiddenWorkspacesManagerModal));
      }
    };
  }
});
