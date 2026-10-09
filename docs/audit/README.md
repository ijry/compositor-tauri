# 全量复刻审计（2026-10-08）

> 此目录是修复前固定基线的审计快照。当前修复结果、重跑入口与剩余项请读 [本轮修复说明](../fixes/README.md)。不要在修改后的业务代码上覆盖这些原始证据。

**结论：未达到“全部功能可用”的验收标准。**

本地业务基线 `b508f9a8d1d5ee74a1b0bec6c308338c4987dc91`，上游 `robbietilton/Compositor@fa41b9b6693b8e1b3a01a13a9ea112edd8e008e3`（1.4.6）。本轮不修改业务代码，不打标签，不部署，不发布，不访问发布密钥。

## 阅读顺序

1. [验收范围与进度](验收范围与进度.md)：哪些已经核查，哪些环境仍未实测。
2. [全量功能验收矩阵](全量功能验收.md)：557条专项记录及每条原始JSON证据。
3. [功能对照总表](功能对照总表.md)：原计划60项与上游README 51项逐一结论。
4. [上游快捷键及命令对照](上游快捷键及命令对照.md)：本地93个命令都有至少一个结果断言；上游115个快捷键与86个菜单源码节点分别对照。
5. [阻断问题与修复清单](阻断问题.md)：74组问题，每组有源码位置、反例、复现证据和未勾选的修复任务。
6. [机器统计](summary.json)、[本轮构建/既有回归](validation.json)。

## 如何理解数字

- 557条是**有重叠的场景/参数/格式记录**，不是557个独立功能，也不是通过率。
- 290条通过、78条部分通过、158条失败、18条未实现、13条未实测。
- 正例只证明指定场景。例如菜单创建默认画布能成功，但新建尺寸对话框没有UI入口；某参数使hash变化，也可能只是把选区清空。
- 部分通过主要表示绑定/差分有结果，但未做完整算法语义、质量或多平台认证。
- 原计划60项：5项通过、16项部分通过、36项失败、2项未实现、1项未实测，**不能保留“全部功能完成”的验收结论**。
- 74组含可复现错误、明确功能缺口、快捷键语义差异及少量低优先级声明不符，不是75个崩溃。
- macOS签名、公证、Xcode要求属于原应用环境；插件形态由OTools发布体系替代，不把“不适用”算通过。

## 验证方法与边界

- 独立 Playwright Chromium，没有使用用户已登录的浏览器或读取用户标签页。
- 菜单、工具、参数、快捷键包含真实鼠标/键盘动作；算法、格式、安全、部分工作流直接调用真实业务模块。每类的范围与脚本可查。
- OTools桥接为**内存文件系统替身**。PNG/JPEG/WebP由浏览器编码器生成；TIFF/DNG由独立二进制构造器生成。PSD基本样本由插件/ag-psd生成，只能证明内部往返，不能替代真实Photoshop文件。
- 路径越界只验证生成的写入请求和虚拟文件落点，未写出真实磁盘，也未证明能绕过真实宿主访问控制。
- 参考上游源码和标准数值作为预期，没有在Windows运行Swift/Metal版。Canvas标准混合与独立公式允许2个通道值误差。
- RAW灰阶和均匀Bayer用例是必要数值合同，不代表完整厂商RAW兼容/色彩质量认证。
- 真实OTools、系统对话框/剪贴板、Mac、Photoshop、HEIC/PSB/相机样本、危险大内存压力及发布服务均未冒认通过。

## 重跑

在仓库根目录执行，先另开终端启动**本地审计开发服务器**：

```powershell
pnpm exec vite --host 127.0.0.1 --port 5194 --strictPort
```

然后以固定SHA的参考仓库路径运行全部专项（不修改业务、不发布）：

```powershell
node scripts/audit/run.mjs "<上游参考仓库路径>"
```

也可以分项运行，例如：

```powershell
node scripts/audit/menus.mjs
node scripts/audit/tools.mjs
node scripts/audit/parameters.mjs
node scripts/audit/shortcuts.mjs
node scripts/audit/contracts.mjs
node scripts/audit/parity.mjs
node scripts/audit/edges.mjs
node scripts/audit/raw-contract.mjs
node scripts/audit/render.mjs
node scripts/audit/report.mjs
node scripts/audit/verify.mjs
```

多数交互脚本支持在命令末尾传案例ID，只重跑该项并合并证据（详见脚本 `selected`）。`formats/raw/kernels/raw-contract/render`按整组运行。

**专项脚本默认收集所有结果并写JSON，不因为发现缺陷提前停止。进程正常退出不等于功能通过。** 严格验收门禁：

```powershell
node scripts/audit/report.mjs --strict
```

当前应返回非零，因为仍有失败、缺失、部分通过和未实测项；不要为得到绿色而删用例或放宽预期。

本轮既有验证：

```powershell
pnpm typecheck
pnpm build
pnpm exec playwright test --workers=2
node --test scripts/*.test.mjs
python scripts/verify-plugin.py dist-pack --packid otools-compositor --version 0.1.0
```

类型检查、构建、147项旧浏览器回归、14项发布脚本回归、现有包静态校验均通过，**但不能据此推断本次专项也通过**。

## 后续修复顺序

1. 保存路径与工程/PSD数据保真、RAW数值基础、导入事务。
2. 选区布尔/羽化/套索、仿制、图层/组变换与拖拽、模糊/混合模式。
3. 补齐调整/效果/RAW/滤镜预览编辑器及可编辑形状/渐变。
4. 统一快捷键语义、颜色/历史面板、参考线/网格/裁剪交互及中文文案。
5. 逐项将失败用例转为通过，再进行真实OTools和真实格式样本验收；最后才考虑发布。

补充排除误报：上游光源角与内部阴影偏移角的差异已由工程codec适配，边界导入/合成/导出验证通过，不列为缺陷。
