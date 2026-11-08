# DSH Hidden Workspaces & Search Shield (工作区隐身与检索隔离插件)

DeepSeek Harness (DSH) 插件：方便地隐藏指定工作区。隐藏后未手动唤出前，DSH 自动在侧边栏、全局搜索、会话列表及 Agent 历史检索中完全隔离排除其内容。

---

## ✨ 核心特性

- 🛡️ **全局检索彻底隔离**：
  处于隐匿状态的工作区及其所属会话，被 DSH 全局会话搜索（`sessionController.search`）与列表检索（`sessionController.list`）底层静默过滤，杜绝检索泄漏。
- 🤖 **Agent 智能体权限守卫**：
  自动注册 `tools.guard`，阻止 Agent 工具跨工作区查询或读取已隐匿会话的历史记录。
- 🔒 **便捷唤出与状态管理**：
  - **侧边栏快捷入口**：侧边栏底部（设置图标旁）提供一键管理入口。
  - **全局快捷键**：支持快捷键 `Ctrl + Shift + H`（macOS 为 `Cmd + Shift + H`）随时呼出管理面板。
  - **临时唤出 (Summon) / 重新隐匿 (Shield Again)**：支持临时解除隔离进行编辑，或彻底解除隐匿。
  - **口令保护 (PIN)**：支持为特定敏感工作区设置唤出口令。
- 💾 **无损持久化**：
  隐匿配置自动持久化在本地配置目录（`~/.dsh/hidden_workspaces.json`），重启 DSH 依然有效。

---

## 📦 安装方法 (Installation)

### 通过 DeepSeek Harness 插件管理器安装

1. 克隆本仓库到您的工作区：
   ```bash
   git clone https://github.com/basiak1438/dsh-hidden-workspaces.git
   ```
2. 在 DSH 中使用插件管理器安装本目录即可：
   ```bash
   # 或者使用 DSH plugin_manager 工具安装该目录
   ```

---

## ⌨️ 快捷键与使用

| 功能 | 操作方式 |
| :--- | :--- |
| **打开/关闭管理面板** | 快捷键 `Ctrl + Shift + H` 或点击侧边栏底部隐身图标 |
| **一键隐匿** | 在弹窗下拉列表中选择工作区，点击【一键隐匿】 |
| **手动唤出** | 在已隐匿列表中点击【手动唤出】（如有口令需输入验证） |
| **重新隐匿** | 对已临时唤出的工作区点击【重新隐匿】 |
| **彻底解除** | 点击【解除隐匿】恢复为普通工作区 |
| **控制台命令** | 聊天框输入 `/summon-workspaces` 或 `/reshide-workspaces` |

---

## 📄 License

MIT
