# 本轮修复交付说明

> **补充生产门禁**：此页74项是原审计清单，不是无缺陷保证。新增PSD/RAW两项错误的修复、限制及306项回归见 [生产阻断修复](production/README.md)。原生可编辑PSD调整层及真实宿主/厂商格式没有因此宣称通过。

> **后续进展**：剩余三项已继续实现，最新范围、完整回归和提交记录见 [第二批说明](remaining/README.md)；下面71/1/2是上一批历史记录，当前状态以 [修复进度](修复进度.md) 为准。

## 最新状态

剩余3项已闭环，审计清单74项均在列明的本地支持范围内修复；249项浏览器回归与14项发布脚本测试通过。详见 [最新验证](remaining/validation.json) 和 [逐项进度](修复进度.md)。真实宿主和格式变体仍按说明保留未实测边界。

## 第一批状态（保留历史）

按原审计74组问题逐项处理：

- **71项已修复并在列出的本地场景验证**。
- **1项部分完成**：`ISSUE-065` 全部文案中文化。已修菜单、锚点、参数表、Element Plus，未把第三方错误/字体等文本宣称为逐句验收完成。
- **2项未完成**：
  - `ISSUE-062` 大PSD按预算裁层解码。先完整解码再裁剪不能降低峰值内存，不能当作这个功能实现。
  - `ISSUE-063` 全链路16位像素精度。内部仍然使用8位像素；不能仅改数组类型后勾选完成。

[逐项勾选和证据](修复进度.md) · [机器进度](progress.json) · [原始审计](../audit/README.md)

## 已修复范围

工程保存ID/尺寸防护，原版曲线/渐变映射/形状/剪贴引用；PSD旋转外观、蒙版、6种效果、文字及24种混合模式的内部往返；TIFF分块和标准LZW DNG；RAW归一化及去马赛克。

选区布尔、羽化、套索、内容识别、仿制、直线绘画；组和多选变换、嵌套拖拽复制、独立蒙版、选区像素移动复制、比例裁剪与吸附。

新增独立Vue组件：曲线、调整参数、效果参数、RAW参数、图片预览、滤镜会话/弹窗、命令面板。完善新建/导入确认取消/撤销、JPEG实时预览、快捷键、颜色和历史面板、参考线网格、图层菜单与跨项目拖放。

## 验证方式

原审计证据 `docs/audit` 保留。修复期间重新观察的失败在 `red/`，修复后的结果在 `results/`。不以删除失败用例或修改断言为“修复”。

界面行为已按上游改动的地方，使用新合同测试：例如新建须经过尺寸表单；PSD报告确认后才导入；滤镜菜单打开预览而底层直接算法API仍保留。旧审计脚本中依赖旧入口的预期不能继续用作这些新流程的验收，见 `scripts/fixes/ui.mjs`、`workflows.mjs` 及 `tests/layout/full-audit-fixes.spec.ts`。

数值差分仍标“部分通过”：它只证明参数接线，不是全部照片质量认证。每项勾选是**对应审计反例已经消除**，不代表同名功能任意输入、所有平台、真实Photoshop和相机格式都已验证。

真实OTools宿主/系统对话框、真实RAW/HEIC/PSB、macOS和极端资源压力仍需实测。本轮没有读取PAT、没有发布市场、没有覆盖安装目录。

## 重跑

先在仓库根目录启动Vite：

```powershell
pnpm exec vite --host 127.0.0.1 --port 5194 --strictPort
```

另一个终端：

```powershell
$env:AUDIT_OUT='docs/fixes/results'
node scripts/fixes/ui.mjs
node scripts/fixes/workflows.mjs
node scripts/fixes/psd-effects.mjs
node scripts/fixes/psd-blends.mjs
node scripts/audit/tools.mjs
node scripts/audit/parameters.mjs
node scripts/audit/kernels.mjs
node scripts/audit/raw-contract.mjs
node scripts/audit/formats.mjs
node scripts/fixes/progress.mjs
```

`ui.mjs` 与 `workflows.mjs` 的任何失败都会返回非零；一般审计脚本收集完所有结果后正常退出，不等于全部业务通过。

常规回归：

```powershell
pnpm build
pnpm exec playwright test --workers=2
node --test scripts/*.test.mjs
node scripts/pack-plugin.mjs --out dist-pack --version 0.1.0
python scripts/verify-plugin.py dist-pack --packid otools-compositor --version 0.1.0
```

最终执行次数及包SHA256见 `validation.json`。只生成本地包，不是发布。

### 原验收脚本的入口迁移

`results/`中的历史运行结果没有被覆盖成虚假的通过。部分原用例依赖修复前菜单快照或旧入口，已由新的实际UI合同替代，逐条对应见 [superseded-checks.json](superseded-checks.json)。未完成的16位与大PSD用例仍保留失败/未实现状态，没有替代为绿灯。
