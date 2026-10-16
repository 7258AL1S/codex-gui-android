export const LOCALE_STORAGE_KEY = "codex-webui-locale";
export const LOCALE_PREFERENCES = Object.freeze(["system", "zh-CN", "en"]);

const ZH_CN = Object.create(null);

Object.assign(ZH_CN, {
  "Log in": "登录",
  "Log out": "退出登录",
  "Password": "密码",
  "Confirm password": "确认密码",
  "Set a LAN password": "设置局域网密码",
  "New password": "新密码",
  "Set password": "设置密码",
  "Setting password…": "正在设置密码…",
  "Logging in…": "正在登录…",
  "Password must be at least 12 characters": "密码至少需要 12 个字符",
  "Passwords do not match": "两次输入的密码不一致",
  "A password was already set. Log in to continue.": "密码已设置，请登录后继续。",
  "Unable to set the password": "无法设置密码",
  "Unable to log in": "无法登录",
  "Codex WebUI login": "Codex WebUI 登录",
  "Codex WebUI password setup": "Codex WebUI 密码设置",
  "New task": "新任务",
  "New chat": "新对话",
  "New tab": "新标签页",
  "Path": "路径",
  "Collapse path": "收起路径",
  "Git": "Git",
  "Commit": "提交",
  "Commit staged changes": "提交已暂存的改动",
  "Commit message": "提交信息",
  "Commit message is required": "请填写提交信息",
  "Committed": "已提交",
  "Stage": "暂存",
  "Unstage": "取消暂存",
  "Discard": "丢弃改动",
  "These edits will be lost. This cannot be undone.": "这些改动会永久丢失，无法撤销。",
  "Fetch": "取回远端",
  "Fetched": "已取回远端引用",
  "Pull": "拉取",
  "Push": "推送",
  "Fetch and fast-forward the current branch. No merge commit is created.": "拉取并快进当前分支（不产生合并提交）。",
  "Push the current branch to its upstream. This publishes commits to the remote.": "把当前分支推送到上游——这会把提交发布到远端。",
  "Nothing staged": "没有已暂存的改动",
  "No changes": "没有改动",
  "No untracked files": "没有未跟踪文件",
  "No worktrees": "没有 worktree",
  "Create worktree": "新建 worktree",
  "Create a new branch": "新建分支",
  "Branch name": "分支名",
  "Branch name is required": "请填写分支名",
  "Worktree created": "worktree 已创建",
  "Remove worktree": "删除 worktree",
  "Removal failed": "删除失败",
  "Force remove": "强制删除",
  "Force removal deletes uncommitted work in that worktree.": "强制删除会连带丢掉那个 worktree 里未提交的改动。",
  "Prune stale": "清理失效记录",
  "Pruned": "已清理",
  "Terminal is not connected": "终端还没连上",
  "Nothing here": "这里没有文件",
  "No matches": "没有匹配的文件",
  "Binary file — no text preview": "二进制文件，不提供文本预览",
  "Save": "保存",
  "Save file?": "保存这个文件？",
  "Saved": "已保存",
  "Open": "打开",
  "Remove": "删除",
  "Switch": "切换",
  "Switch workspace?": "切换工作区？",
  "Use this worktree as the working folder for new sessions?": "把新会话的工作目录切到这个 worktree？",
  "Workspace switched": "工作区已切换",
  "No workspace folder is selected": "还没有选择工作目录",
  "Detached HEAD": "游离 HEAD",
  "In progress: ": "进行中：",
  "modified": "已修改",
  "added": "已添加",
  "deleted": "已删除",
  "renamed": "已重命名",
  "copied": "已复制",
  "conflict": "冲突",
  "changed": "已改动",
  "Search": "搜索",
  "Search chats": "搜索对话",
  "Close search": "关闭搜索",
  "Projects": "项目",
  "Project": "项目",
  "Tasks": "任务",
  "Connecting": "正在连接",
  "Connecting to Codex": "正在连接 Codex",
  "Connecting to Codex…": "正在连接 Codex…",
  "Codex connected": "Codex 已连接",
  "Settings": "设置",
  "Profile": "个人资料",
  "Usage": "用量",
  "Keyboard shortcuts": "键盘快捷键",
  "Help": "帮助",
  "Open profile menu": "打开个人资料菜单",
  "Open settings": "打开设置",
  "Toggle sidebar": "切换侧边栏",
  "Toggle bottom panel": "切换底部面板",
  "Toggle terminal panel": "切换终端面板",
  "Toggle summary": "切换摘要",
  "Toggle side panel": "切换右侧面板",
  "What can I help?": "我能帮你做些什么？",
  "Do anything": "交给 Codex 处理",
  "Task prompt": "任务输入",
  "Composer suggestions": "输入建议",
  "Attached context": "已附加的上下文",
  "Attach files and folders": "附加文件和文件夹",
  "Attach files": "附加文件",
  "Upload failed": "上传失败",
  "(uploading…)": "（上传中…）",
  "Still sending the previous message. Try again in a moment.": "上一条消息还在发送中，稍等片刻再试。",
  "Still uploading — wait a moment.": "附件还在上传中，稍等一下。",
  "no answer from the bridge (the phone may have slept)": "桥没有响应（手机可能休眠了），会自动重试一次",
  "(reading…)": "（读取中…）",
  "waiting for the bridge…": "等待桥响应…",
  "(attachment)": "（附件）",
  "Waiting for the upload to finish…": "正在等待附件上传完成…",
  "Answered elsewhere": "已在别处处理",
  "Allow once": "允许一次",
  "Allow this conversation": "允许本次会话",
  "Allow all edits": "允许全部修改",
  "Deny": "拒绝",
  "Terminal": "终端",
  "Edit files": "修改文件",
  "Internet access": "网络访问",
  "Reason": "原因",
  "Allow ChatGPT to run this command?": "允许运行这条命令？",
  "Allow ChatGPT to edit the following file?": "允许修改以下文件？",
  "Allow ChatGPT to edit the following files?": "允许修改以下文件？",
  "The bridge has not answered for 8s. Termux is probably suspended; setting its battery policy to “Unrestricted” fixes it.": "等待桥响应已超过 8 秒：Termux 很可能被系统挂起了。把 Termux 的省电策略设成「无限制」就能改善。",
  "The bridge was just restarted (N s ago) — the page is reconnecting.": "桥刚刚被重启过（N 秒前），页面正在重连——几秒内会自己恢复。",
  "Could not read the selected file": "无法读取所选文件",
  "Start dictation": "开始听写",
  "Send message": "发送消息",
  "Steer": "插入消息",
  "Stop": "停止",
  "Change permissions": "更改权限",
  "Ask for approval": "请求审批",
  "How should Codex actions be approved?": "Codex 的操作应如何审批？",
  "Context usage": "上下文用量",
  "Reasoning effort": "思考强度",
  "Loading models…": "正在加载模型…",
  "None": "无",
  "Minimal": "最低",
  "Low": "低",
  "Medium": "中",
  "High": "高",
  "Extra High": "极高",
  "Max": "最大",
  "Ultra": "超高",
  "Review": "审阅",
  "Terminal": "终端",
  "Browser": "浏览器",
  "Files": "文件",
  "Side task": "子任务",
  "Side tasks": "子任务",
  "Summary": "摘要",
  "Environment": "环境",
  "Scheduled": "计划任务",
  "Computer Use": "电脑操作",
  "Computer use": "电脑操作",
  "Plan": "计划",
  "Sources": "来源",
  "Local workspace": "本地工作区",
  "Remote workspace": "远程工作区",
  "No project": "无项目",
  "No changes yet": "暂无更改",
  "Changes made by Codex will appear here.": "Codex 所做的更改会显示在这里。",
  "Switch to split diff": "切换到并排差异",
  "Switch to unified diff": "切换到统一差异",
  "Toggle word wrap": "切换自动换行",
  "Enable word wrap": "启用自动换行",
  "Disable word wrap": "关闭自动换行",
  "Collapse all diffs": "折叠所有差异",
  "Expand all diffs": "展开所有差异",
  "Undo changes": "撤销更改",
  "Reapply changes": "重新应用更改",
  "Changes reverted": "更改已撤销",
  "Changes reapplied": "更改已重新应用",
  "This task is currently running in another Codex app or CLI. Close it there, then try again.": "此任务正在另一个 Codex 应用或 CLI 中运行。请先在那里关闭或结束任务，然后重试。",
  "This task could not be found. Refresh the task list and try again.": "找不到此任务。请刷新任务列表后重试。",
  "Delete thread": "删除任务",
  "Delete thread “{title}”": "删除任务“{title}”",
  "Delete “{title}”? This permanently deletes the thread and its descendants.": "删除“{title}”？这将永久删除此任务及其子任务。",
  "Thread deleted": "任务已删除",
  "Could not delete thread": "无法删除任务",
});

Object.assign(ZH_CN, {
  "General": "通用",
  "Appearance": "外观",
  "Configuration": "配置",
  "Personal": "个人",
  "Integrations": "集成",
  "Coding": "编程",
  "Archived": "已归档",
  "Archived chats": "已归档的对话",
  "Plugins": "插件",
  "Skills": "技能",
  "Connections": "连接",
  "Cloud preferences": "云端偏好设置",
  "Cloud environments": "云端环境",
  "Code review": "代码审阅",
  "Git": "Git",
  "Hooks": "钩子",
  "Worktrees": "工作树",
  "Back to app": "返回应用",
  "Back to settings": "返回设置",
  "Search settings": "搜索设置",
  "Search settings…": "搜索设置…",
  "Clear settings search": "清除设置搜索",
  "No results found": "未找到结果",
  "Permissions": "权限",
  "Auto-review": "代我审批",
  "Show “Approve for me” in the composer": "在输入框中显示“代我审批”",
  "Full access": "完全访问权限",
  "Show unrestricted access in the composer": "在输入框中显示不受限制的访问权限",
  "Selected mode": "所选模式",
  "Permission mode used for new turns": "新任务使用的权限模式",
  "Working folder used for new chats": "新对话使用的工作文件夹",
  "Notifications": "通知",
  "Task notifications": "任务通知",
  "Show a browser notification when a task completes": "任务完成时显示浏览器通知",
  "Task completed": "任务完成",
  "Browser notifications are blocked": "浏览器通知已被阻止",
  "Theme": "主题",
  "System": "系统",
  "Language": "语言",
  "Interface language": "界面语言",
  "System default": "跟随系统",
  "Interface scale": "界面缩放",
  "Default": "默认",
  "Model": "模型",
  "Approval": "审批",
  "Web search": "网页搜索",
  "Automatic": "自动",
  "Installed plugins": "已安装的插件",
  "Plugin sources": "插件来源",
  "Installed skills": "已安装的技能",
  "Not configured": "未配置",
  "Browser access": "浏览器访问",
  "Network access": "网络访问",
  "Inherited from permissions": "继承自权限设置",
  "Connected services": "已连接的服务",
  "Diff view": "差异视图",
  "Unified": "统一",
  "Branch format": "分支格式",
  "Environments": "环境",
  "Review instructions": "审阅说明",
  "Git integration": "Git 集成",
  "Configured hooks": "已配置的钩子",
  "Worktree behavior": "工作树行为",
  "Turn on Full Access?": "启用完全访问权限？",
  "Codex will be able to run commands, use the internet, and create and edit files anywhere on this computer without your permission.": "Codex 无需再次获得许可，即可运行命令、使用互联网，并在这台电脑的任意位置创建和编辑文件。",
  "Files and folders": "文件和文件夹",
  "Read, create, modify, upload, or delete files anywhere on this computer": "读取、创建、修改、上传或删除这台电脑任意位置的文件",
  "Terminal commands": "终端命令",
  "Run commands, install software, and change system settings": "运行命令、安装软件和更改系统设置",
  "Internet and connected apps": "互联网和已连接的应用",
  "Access websites, send data, and use enabled plugins": "访问网站、发送数据并使用已启用的插件",
  "Cancel": "取消",
  "Confirm": "确认",
  "Ready": "就绪",
  "Browser navigation": "浏览器导航",
  "Go back": "后退",
  "Go forward": "前进",
  "Refresh page": "刷新页面",
  "Browser URL": "浏览器网址",
  "Enter URL": "输入网址",
  "Go to URL": "打开网址",
  "Open in new tab": "在新标签页打开",
  "Enter a URL to browse": "输入网址开始浏览",
  "Pages stay in their original site context. Some sites do not allow embedding.": "网页会保留原站点上下文，部分网站不允许嵌入显示。",
  "Loading page…": "正在加载页面…",
  "Page could not be embedded": "无法嵌入此页面",
  "Open externally": "在外部打开",
  "Embedded browser page": "嵌入式浏览器页面",
  "Bottom panel": "底部面板",
  "Close bottom panel": "关闭底部面板",
  "Close panel": "关闭面板",
  "Close summary": "关闭摘要",
  "Open side panel tab": "打开右侧面板标签页",
  "Task side panel": "任务右侧面板",
  "Image": "图片",
  "Image unavailable": "图片不可用",
  "No models are available": "没有可用模型",
  "This provider returned no models. Check the Codex model catalog configuration.": "当前 provider 没有返回任何模型，请检查 Codex 的模型目录配置。",
  "Open original": "打开原图",
  "Close image viewer": "关闭图片查看器",
  "Image could not be loaded.": "无法加载图片。",
});

Object.assign(ZH_CN, {
  "Working": "正在处理",
  "Completed": "已完成",
  "Tool failed": "工具调用失败",
  "Thinking": "思考中",
  "Thought": "已思考",
  "Running command": "正在运行命令",
  "Ran": "已运行",
  "Ran command": "已运行命令",
  "Command failed": "命令运行失败",
  "Editing files": "正在编辑文件",
  "Edited a file": "已编辑 1 个文件",
  "Edited files": "已编辑文件",
  "File edit failed": "文件编辑失败",
  "Reading": "正在读取",
  "Read": "已读取",
  "Searching": "正在搜索",
  "Searched": "已搜索",
  "Listing": "正在列出",
  "Listed": "已列出",
  "Viewing images": "正在查看图片",
  "Viewed image": "已查看图片",
  "Viewed images": "已查看图片",
  "Image view failed": "图片查看失败",
  "Searching the web": "正在搜索网页",
  "Searched the web": "已搜索网页",
  "Search failed": "搜索失败",
  "Starting side task": "正在启动子任务",
  "Started side task": "已启动子任务",
  "Sending input to side task": "正在向子任务发送消息",
  "Sent input to side task": "已向子任务发送消息",
  "Resuming side task": "正在恢复子任务",
  "Resumed side task": "已恢复子任务",
  "Waiting for side tasks": "正在等待子任务",
  "Waited for side tasks": "已等待子任务",
  "Closing side task": "正在关闭子任务",
  "Closed side task": "已关闭子任务",
  "Updating side task": "正在更新子任务",
  "Updated side task": "已更新子任务",
  "Side task failed": "子任务失败",
  "Side task interrupted": "子任务已中断",
  "Side task active": "子任务正在运行",
  "Side task started": "子任务已启动",
  "Waiting for approval": "正在等待审批",
  "Needs approval": "等你审批",
  "Needs an answer": "等你回答",
  "Review target": "审查目标",
  "Uncommitted changes": "当前改动",
  "Everything not yet committed": "所有还没提交的改动",
  "Compare against a branch": "对比某个分支",
  "Pick a base branch": "选一个基线分支",
  "Review a commit": "审查某个提交",
  "Pick a recent commit": "从最近提交里选",
  "Custom instructions": "自定义审查要求",
  "Describe what to review": "请写明要审查什么",
  "Review started — the result appears in the conversation": "审查已开始——结果会出现在对话里",
  "No branches": "没有可用的分支",
  "No commits": "没有可用的提交",
  "No active conversation": "当前没有打开的会话",
  "Sandbox is NOT enforced on this platform: measured with read-only and workspace-write policies, commands could still write outside the workspace and reach the network. Treat the permission chips as a display of intent, not as a boundary.": "本平台的沙箱没有生效（实测）：即使用 read-only / workspace-write 策略，命令照样能写工作区外、照样能联网。请把权限选项当成\u201c意图声明\u201d，不要当成安全边界。",
  "This is what actually gates commands: the agent asks, and nothing runs until you answer.": "真正起作用的是审批：模型会先问，你不回答它就不执行。",
  "Accepted by the backend, but see the notice above — it does not isolate anything here.": "后端接受这个字段，但见上面的提示——在本机它不隔离任何东西。",
  "Provider": "provider",
  "Permission profiles": "权限档位",
  "Reported by permissionProfile/list.": "来自 permissionProfile/list。",
  "Approval policy": "审批策略",
  "Write to config.toml?": "写入 config.toml？",
  "Account": "账户",
  "This provider does not expose an account (third-party provider). Everything above is local; billing and limits live with your provider.": "这个 provider 不提供账户信息（第三方）。本地信息都在上面；计费与限额在你的 provider 那边。",
  "Usage": "用量",
  "Rate limits": "限额",
  "Installed plugins": "已安装插件",
  "MCP servers": "MCP 服务器",
  "Reload MCP config": "重新加载 MCP 配置",
  "MCP config reloaded": "MCP 配置已重新加载",
  "Add a marketplace": "添加插件市场",
  "local directory or https URL": "本地目录或 https 地址",
  "Add": "添加",
  "Add a plugin marketplace?": "添加插件市场？",
  "A marketplace source is required": "请填写市场来源",
  "Marketplace added": "市场已添加",
  "Remove this marketplace?": "移除这个市场？",
  "Marketplace removed": "市场已移除",
  "No plugin marketplace is configured. Add one below (a local directory containing marketplace.json, or an https URL).": "还没有配置插件市场。可以在下面添加（含 marketplace.json 的本地目录，或 https 地址）。",
  "plugins": "个插件",
  "Install": "安装",
  "Uninstall": "卸载",
  "installed": "已安装",
  "not installed": "未安装",
  "uninstalled": "已卸载",
  "Preview": "预览",
  "Previewing in the Browser panel": "在侧栏浏览器面板里预览",
  "Take a photo": "拍照",
  "Skills": "技能",
  "Hooks": "钩子",
  "What this build uses instead": "本机构建实际用什么替代",
  "Could not load: ": "加载失败：",
  "Open in another app": "用其他应用打开",
  "Share": "分享",
  "Save to Downloads": "存到 Download",
  "Handed to the system app": "已交给系统应用",
  "Copy into Downloads?": "复制到 Download 目录？",
  "Copy": "复制",
  "Copied to Downloads": "已复制到 Download",
  "Experimental": "实验特性",
  "This build ignores experimentalFeature/enablement/set: measured, the call returns an empty enablement and the state never changes. So this page lists the real flags without offering switches.": "本机构建会忽略 experimentalFeature/enablement/set（实测：调用返回空的 enablement，状态始终不变），所以这里只列出真实开关状态，不提供点了没用的按钮。",
  "No experimental features are reported by this build.": "这个构建没有报告任何实验特性。",
  "On": "开",
  "Off": "关",
  "Worked": "处理过程",
  "Activity failed": "操作失败",
  "Read files": "已读取文件",
  "Ran commands": "已运行命令",
  "Edited files": "已编辑文件",
  "No output": "无输出",
  "Success": "成功",
  "Failed": "失败",
  "Stopped": "已停止",
  "Stopped command": "已停止命令",
  "Waiting for patch details…": "正在等待补丁详情…",
  "No patch details": "无补丁详情",
  "Plan mode": "规划模式",
  "Approve for me": "代我审批",
  "Always ask for permission before editing external files or using the internet": "编辑工作区外的文件或使用互联网前始终请求许可",
  "Only ask for actions detected as potentially unsafe": "仅在检测到可能不安全的操作时请求许可",
  "Not allowed by managed settings": "受管理设置限制，无法使用",
  "Custom": "自定义",
  "Custom (config.toml)": "自定义（config.toml）",
  "Custom permissions": "自定义权限",
  "Custom permission profile": "自定义权限配置",
  "Uses permissions defined in config.toml": "使用 config.toml 中定义的权限",
  "Unrestricted access to the internet and any file on your computer": "不受限制地访问互联网和此电脑上的任意文件",
  "API key mode": "API 密钥模式",
  "Codex account": "Codex 账户",
  "Reasoning": "思考强度",
  "Select model": "选择模型",
  "Back": "返回",
  "No matching tasks": "没有匹配的任务",
  "No subfolders": "没有子文件夹",
  "Loading folders…": "正在加载文件夹…",
  "No folder selected": "尚未选择文件夹",
  "Use this folder": "使用此文件夹",
  "Choose where new tasks should work.": "选择新任务的工作位置。",
  "None": "无",
  "Don't work in a project": "不在项目中工作",
  "Parent folder": "上一级文件夹",
  "Go": "前往",
  "Side tasks started by this chat will appear here.": "此对话启动的子任务会显示在这里。",
  "No side tasks": "没有子任务",
  "Choose or switch the local project folder available to this WebUI.": "选择或切换此 WebUI 可访问的本地项目文件夹。",
  "Choose project folder": "选择项目文件夹",
  "Open Browser from the right panel to keep it beside the chat.": "请从右侧面板打开浏览器，以便与对话并排显示。",
  "Scheduled task data requires the native desktop bridge.": "计划任务数据需要原生桌面桥接。",
  "Computer Use controls require the native desktop bridge.": "电脑操作控件需要原生桌面桥接。",
  "Plan data is not exposed by app-server.": "app-server 未提供计划数据。",
  "Side task data requires the native desktop bridge.": "子任务数据需要原生桌面桥接。",
  "Conversation source data is not exposed by app-server.": "app-server 未提供对话来源数据。",
});

const ZH_CN_PATTERNS = [
  [/^(\d+) changed files?$/, match => `${match[1]} 个文件已更改`],
  [/^Review (\d+) changed files?$/, match => `审阅 ${match[1]} 个已更改文件`],
  [/^Load earlier messages \((\d+)\)$/, match => `加载更早的消息（${match[1]}）`],
  [/^Worked for (.+)$/, match => `处理耗时 ${match[1]}`],
  [/^Reasoning: (.+)$/, match => `思考强度：${translate(match[1], "zh-CN")}`],
  [/^Model: (.+)$/, match => `模型：${match[1]}`],
  [/^Context usage: (\d+)%$/, match => `上下文用量：${match[1]}%`],
  [/^(\d+)% full$/, match => `已使用 ${match[1]}%`],
  [/^(\d+)% used \((\d+)% left\)$/, match => `已使用 ${match[1]}%（剩余 ${match[2]}%）`],
  [/^(\d+)k \/ (\d+)k tokens used$/, match => `已使用 ${match[1]}k / ${match[2]}k 令牌`],
  [/^(\d+) images$/, match => `${match[1]} 张图片`],
  [/^(\d+) side tasks?$/, match => `${match[1]} 个子任务`],
  [/^Ran (.+)$/, match => `已运行 ${match[1]}`],
  [/^Stopped (.+)$/, match => `已停止 ${match[1]}`],
  [/^Exit code (\d+)$/, match => `退出码 ${match[1]}`],
  [/^What can I help with in (.+)\?$/, match => `我能为 ${match[1]} 做些什么？`],
  [/^Remove (.+)$/, match => `移除 ${match[1]}`],
];

export function resolveLocale(preference = "system", languages = []) {
  if (preference === "zh-CN") return "zh-CN";
  if (preference === "en") return "en";
  const values = Array.isArray(languages) ? languages : [languages];
  return values.some(value => /^zh(?:-|$)/i.test(String(value || ""))) ? "zh-CN" : "en";
}

function interpolate(template, values = {}) {
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => key in values ? String(values[key]) : match);
}

export function translate(message, locale = "en", values = {}) {
  const source = interpolate(message, values);
  if (locale !== "zh-CN") return source;
  const direct = ZH_CN[message] || ZH_CN[source];
  if (direct) return interpolate(direct, values);
  for (const [pattern, replacement] of ZH_CN_PATTERNS) {
    const match = source.match(pattern);
    if (match) return replacement(match);
  }
  return source;
}

export function createI18n({ storage = globalThis.localStorage, languages = globalThis.navigator?.languages || [] } = {}) {
  let preference = storage?.getItem?.(LOCALE_STORAGE_KEY) || "system";
  if (!LOCALE_PREFERENCES.includes(preference)) preference = "system";
  let locale = resolveLocale(preference, languages);
  const listeners = new Set();
  const api = {
    get preference() { return preference; },
    get locale() { return locale; },
    t(message, values) { return translate(message, locale, values); },
    setPreference(next) {
      if (!LOCALE_PREFERENCES.includes(next)) return false;
      preference = next;
      locale = resolveLocale(preference, languages);
      storage?.setItem?.(LOCALE_STORAGE_KEY, preference);
      for (const listener of listeners) listener(locale, preference);
      return true;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return api;
}

const DOM_I18N_EXCLUDE = [
  "[data-i18n-ignore]",
  "[contenteditable='true']",
  ".message-text",
  ".activity-detail",
  ".activity-output",
  ".approval-reason p",
  ".approval-subtitle",
  ".autocomplete-title",
  ".review-hunks",
  ".side-task-copy small",
  ".terminal-host",
  ".thread-item",
  ".user-message",
  ".thread-name",
  ".review-file-name",
  ".change-path",
  ".folder-item",
  "code",
  "pre",
  "#accountName",
  "#accountMenuName",
  "#accountMenuSubtitle",
  "#browserUrl",
  "#folderPathInput",
  "#folderSelection",
  "#imageViewerPath",
  "#projectName",
  "#projectPath",
  "#settingsAccountName",
  "#settingsAccountMeta",
  "#summaryWorkspace",
  "#threadPath",
  "#threadTitle",
].join(",");

const TRANSLATED_ATTRIBUTES = ["aria-label", "placeholder", "title"];

function translateTextValue(value, i18n) {
  const source = String(value || "");
  const trimmed = source.trim();
  if (!trimmed) return source;
  const translated = i18n.t(trimmed);
  return translated === trimmed ? source : source.replace(trimmed, translated);
}

function isExcluded(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  if (element?.closest?.("[data-i18n-ui]")) return false;
  return Boolean(element?.closest?.(DOM_I18N_EXCLUDE));
}

export function createDomI18n(i18n, { root = globalThis.document } = {}) {
  if (!i18n || !root?.createTreeWalker) return { refresh() {}, disconnect() {} };

  const view = root.defaultView || root.ownerDocument?.defaultView || globalThis;
  const NodeFilterApi = view.NodeFilter || globalThis.NodeFilter;
  const MutationObserverApi = view.MutationObserver || globalThis.MutationObserver;
  const textState = new WeakMap();
  const attributeState = new WeakMap();

  function translateTextNode(node) {
    if (isExcluded(node)) return;
    const current = node.nodeValue || "";
    let state = textState.get(node);
    if (!state) {
      state = { source: current, last: current };
      textState.set(node, state);
    } else if (current !== state.last) {
      state.source = current;
    }
    const next = translateTextValue(state.source, i18n);
    state.last = next;
    if (current !== next) node.nodeValue = next;
  }

  function translateElementAttributes(element) {
    if (isExcluded(element)) return;
    let states = attributeState.get(element);
    if (!states) {
      states = new Map();
      attributeState.set(element, states);
    }
    for (const name of TRANSLATED_ATTRIBUTES) {
      if (!element.hasAttribute?.(name)) continue;
      const current = element.getAttribute(name) || "";
      let state = states.get(name);
      if (!state) {
        state = { source: current, last: current };
        states.set(name, state);
      } else if (current !== state.last) {
        state.source = current;
      }
      const next = translateTextValue(state.source, i18n);
      state.last = next;
      if (current !== next) element.setAttribute(name, next);
    }
  }

  function translateSubtree(node) {
    if (!node || isExcluded(node)) return;
    if (node.nodeType === 3) {
      translateTextNode(node);
      return;
    }
    if (node.nodeType === 1) translateElementAttributes(node);
    const walker = root.createTreeWalker(node, NodeFilterApi.SHOW_ELEMENT | NodeFilterApi.SHOW_TEXT);
    while (walker.nextNode()) {
      const current = walker.currentNode;
      if (current.nodeType === 3) translateTextNode(current);
      else translateElementAttributes(current);
    }
  }

  function refresh() {
    const documentElement = root.documentElement || root.ownerDocument?.documentElement;
    if (documentElement) documentElement.lang = i18n.locale;
    translateSubtree(root.documentElement || root);
  }

  const observer = MutationObserverApi ? new MutationObserverApi(records => {
    for (const record of records) {
      if (record.type === "characterData") translateTextNode(record.target);
      else if (record.type === "attributes") translateElementAttributes(record.target);
      else for (const node of record.addedNodes) translateSubtree(node);
    }
  }) : null;
  observer?.observe(root.documentElement || root, {
    attributes: true,
    attributeFilter: TRANSLATED_ATTRIBUTES,
    characterData: true,
    childList: true,
    subtree: true,
  });
  const unsubscribe = i18n.subscribe(refresh);
  refresh();

  return {
    refresh,
    disconnect() {
      observer?.disconnect();
      unsubscribe();
    },
  };
}

export { ZH_CN as zhCNMessages };

Object.assign(ZH_CN, {
  "Thread actions": "会话操作",
  "Rename": "重命名",
  "Rename thread": "重命名会话",
  "Fork": "分叉",
  "Archive": "归档",
  "Restore": "恢复",
  "Thread renamed": "已重命名",
  "Thread forked": "已分叉",
  "Thread archived": "已归档",
  "Thread restored": "已恢复",
  "Could not rename thread": "重命名失败",
  "Could not fork thread": "分叉失败",
  "Could not archive thread": "归档失败",
  "Could not restore thread": "恢复失败",
});

Object.assign(ZH_CN, {
  "Showing archived threads": "正在显示已归档会话",
  "Showing active threads": "正在显示进行中的会话",
});

Object.assign(ZH_CN, {
  "Pin": "置顶",
  "Unpin": "取消置顶",
  "Pinned": "置顶",
  "Thread pinned": "已置顶",
  "Thread unpinned": "已取消置顶",
  "Could not pin thread": "置顶失败",
});

Object.assign(ZH_CN, {
  "Compact": "压缩上下文",
  "Thread compaction started": "已开始压缩上下文",
  "Could not compact thread": "压缩失败",
});

Object.assign(ZH_CN, {
  "Conversation mode": "对话模式",
  "Plan mode: Codex will plan before acting": "已切到 Plan 模式：Codex 会先规划再动手",
  "Default mode": "已切回 Default 模式",
});

Object.assign(ZH_CN, {
  "Queue": "排队",
  "Queue for after this turn": "排队（本轮结束后执行）",
  "Queued for after this turn": "已排队，本轮结束后执行",
  "Queued message": "排队中的消息",
  "Could not queue message": "排队失败",
  "No active thread to queue into": "当前没有可排队的会话",
});


Object.assign(ZH_CN, {
  "Automation": "定时任务",
  "Could not read the local scheduler": "读不到本地调度器",
  "Scheduled tasks are driven by the local bridge": "定时任务由本地桥驱动：协议里没有任何调度方法（ClientRequest 里搜不到 schedul*），所以调度、记录、漏跑补跑都是桥自己实现的，用你设置的时间表在桥进程里到点起回合。",
  "What is guaranteed": "能保证什么",
  "Bridge tick": "扫描间隔",
  "Concurrency": "并发上限",
  "No scheduled tasks yet — create one below.": "还没有定时任务，用下面的表单建一个。",
  "Never ran": "还没跑过",
  "Last run": "上次运行",
  "Run now": "运行一次",
  "Pause": "暂停",
  "Resume": "恢复",
  "Paused": "已暂停",
  "Delete": "删除",
  "Delete this scheduled task?": "删除这个定时任务？",
  "Started": "已开始",
  "Task name": "任务名",
  "Prompt to send each run": "每次运行要发的提示词",
  "Working directory": "工作目录",
  "Schedule": "时间表",
  "Every hour": "每小时",
  "Every N hours": "每 N 小时",
  "Daily": "每天",
  "Weekdays": "工作日",
  "Weekly": "每周",
  "Time": "时间",
  "Day of week": "星期",
  "Run in": "运行在",
  "A new conversation": "新会话",
  "An existing conversation": "继续某个会话",
  "Conversation id": "会话 id",
  "If the bridge was away": "桥不在的那段时间",
  "Run the newest missed slot once": "只补最新一次",
  "Do not catch up (still logged)": "不补跑（但会记账）",
  "Approval mode": "审批策略",
  "Ask for approval (may wait for you)": "需要审批（可能等你回答）",
  "Full access (unattended)": "完全访问（无人值守）",
  "Turn timeout (minutes)": "回合超时（分钟）",
  "Create task": "创建任务",
  "Run history": "运行记录",
  "No runs yet.": "还没有运行记录。",
  "Completed": "完成",
  "Failed": "失败",
  "Timed out": "超时",
  "Interrupted": "被中断",
  "Skipped": "已跳过",
  "Running": "运行中",
  "A scheduled task was created": "已创建定时任务",
  "Clearing run history": "清空运行记录",
  "Keeping it alive": "保活与限制",
  "termux-wake-lock": "termux-wake-lock",
  "Keeps the CPU awake (codex-gui-web takes it while the bridge runs)": "让 CPU 不睡（桥跑着的时候由 codex-gui-web 自动成对取/放）",
  "Costs one Termux notification and cannot stop Android from reclaiming the app process.": "代价是一条 Termux 通知；它挡不住系统回收应用进程。",
  "Foreground service + pinned notification (APK)": "前台服务 + 置顶通知（APK）",
  "What the APK uses today": "当前 APK 用的就是这个",
  "Makes the bridge process foreground, so it is far less likely to be killed — not a promise that it never will be.": "把桥所在进程做成前台服务，被杀的概率低得多——但不是「永不被杀」的承诺。",
  "JobScheduler / termux-job-scheduler": "JobScheduler / termux-job-scheduler",
  "Not wired up in this project": "本项目尚未接入（未验证）",
  "System alarms with a 15-minute minimum period and no exact-time guarantee. Fits \"wake the bridge up, then settle the missed slots\" — not precise scheduling.": "系统级闹钟：最小周期 15 分钟、没有绝对时刻保证。适合「把桥唤醒、再按补跑规则结账」，不适合当精确调度器。",
  "Registered": "已注册",
  "Not registered": "未注册",
  "Wake script missing": "唤醒脚本不存在",
  "Never ran yet": "还没跑过",
  "Register now": "立即注册",
  "Registered the 15-minute wake-up": "已注册 15 分钟兜底唤醒",
  "A 15-minute system job keeps the wake lock alive and starts the bridge if it is not running; when the bridge comes back it settles the missed slots with the catch-up rule above. Expect up to ~15 minutes of lateness after the bridge was gone — that is the platform minimum for periodic jobs, not something I can tune away.": "系统里挂着一个 15 分钟周期的作业：补唤醒锁，桥不在就把它拉起来；桥回来之后按上面的补跑规则结账。桥不在过的那些时候，最多会晚约 15 分钟——这是 Android 对周期作业的下限，不是我这里能调掉的设置。",
});


Object.assign(ZH_CN, {
  "An existing conversation": "继续某个会话",
  "Conversation id (manual)": "会话 id（手填）",
  "Loading conversations…": "正在读取会话…",
  "No conversations yet": "还没有会话",
  "No conversations to continue yet — the first one appears here after you chat once.": "还没有可继续的会话；聊过一次之后它就会出现在这里。",
  "Untitled": "未命名",
  "Could not load conversations": "读不到会话列表",
  "— type the conversation id instead.": "—— 改为手填会话 id。",
  "Pick a conversation first": "先选一个会话",
  "Continues": "继续会话",
});


Object.assign(ZH_CN, {
  "Waiting for your approval": "等待你审批",
  "Waiting for your answer": "等待你回答",
  "Open conversation": "打开会话",
});


Object.assign(ZH_CN, {
  "Startup self-check": "启动自检",
  "Bridge start script": "桥的启动脚本",
  "What the app asks Termux to run.": "应用请 Termux 执行的就是它。",
  "Needed for the wake lock, notifications, and the 15-minute fallback wake-up.": "唤醒锁、通知、以及 15 分钟兜底唤醒都靠它。",
  "Codex CLI": "Codex CLI",
  "not found on PATH": "PATH 里找不到",
  "Bridge state directory": "桥的状态目录",
  "Automation records and uploads live here.": "定时任务记录与上传的附件都在这里。",
  "Fallback wake-up job": "兜底唤醒作业",
  "registered": "已注册",
  "not registered": "未注册",
  "App side (last report)": "应用侧（最近一次上报）",
  "Termux installed": "已装 Termux",
  "Termux missing": "未装 Termux",
  "run command granted": "已授权 run command",
  "run command NOT granted": "未授权 run command",
  "notifications allowed": "通知已允许",
  "notifications blocked": "通知被禁止",
  "no report yet — open the app once": "还没有上报过——打开一次应用即可",
  "~/bin/codex-gui-web is missing — the app cannot start the bridge. Restore it from the project or reinstall the Termux side.": "~/bin/codex-gui-web 不存在——应用没法启动桥。把项目里的这个脚本恢复回去，或重装 Termux 侧。",
  "Termux:API is missing: no wake lock, no notifications from Termux, and no 15-minute fallback wake-up.": "没装 Termux:API：不会有唤醒锁、不会有 Termux 通知、也没有 15 分钟兜底唤醒。",
  "The run-command permission is not granted: every cold start will briefly switch to Termux.": "没有授予 run-command 权限：每次冷启动都会短暂切到 Termux。",
  "Startup self-check failed": "启动自检失败",
});


Object.assign(ZH_CN, {
  "Could not open this file": "打不开这个文件",
});
