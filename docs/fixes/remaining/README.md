# 剩余三项修复说明（2026-10-09）

## 提交与执行边界

- 已先提交上一轮成果：`06be15d`，分支 `fix/full-feature-audit`。
- 本目录记录随后处理的 `ISSUE-062`、`ISSUE-063`、`ISSUE-065`，不覆盖 `docs/audit` 的修复前证据。
- 没有读取发布凭据、没有部署覆盖宿主插件、没有打标签或发布市场。真实 OTools、Photoshop、相机厂商样本仍不冒认为已经实测。

## 大PSD / PSB预算解码

使用 ag-psd 公共的 `useRawData:true` 保留压缩通道视图，再由 `psdBudget.ts` 统一计算整份文档的内存规划。**在分配图层像素之前**决定保留全图还是仅保留图层/蒙版与画布的交集。

`psdChannel.ts` 支持：

- 未压缩通道：直接读取目标区域，不复制整块通道。
- RLE / PackBits：支持PSD两字节及PSB四字节行表，只解码目标行。
- ZIP及ZIP预测器：流式读取固定块，不积累完整解压通道；16位预测值按大端样本累加。
- 通道长度、解码长度、压缩校验和及不支持的压缩方式有拒绝路径。

裁剪后仍超预算时明确报错，原文档不应用；画布外空交集图层的跳过与蒙版裁剪写入转换报告。蒙版矩形之外的默认覆盖率、层级、位置和混合模式被保留。

**预算口径**：源文件字节、输出像素及蒙版、固定解码暂存和保守的元数据/合成预留。这是可检查的算法规划，不是浏览器进程RSS保证，不包括用户同时打开的其他应用。ZIP通道超过1GiB解码工作量会拒绝，防止压缩炸弹或不可控CPU阻塞。32位HDR、CMYK等不在本次RGB/灰度8/16位支持范围。

## 8 / 16位链路

- 8位文档继续使用 `Uint8ClampedArray`；16位文档使用0–255的 `Float32Array` 工作值，避免多次运算提前舍入。
- 图层和蒙版均携带位深。导入/粘贴到16位文档时统一提升工作精度，并在转换前检查额外内存预算；结构历史恢复文档位深。
- 合成、混合、颜色调整、重采样、绘画底层、滤镜、选区复制、蒙版应用和撤销快照保留浮点值。历史预算改为真实 `byteLength`。
- 16位PNG读取/写入不经过Canvas。覆盖灰度、RGB、灰度透明、RGBA、五种行滤波和Adam7交错；校验CRC并拒绝损坏数据。
- 16位PSD通道以大端整数保存，利用ag-psd编码层级与元数据；另用其读取器验证输出通道的最低有效位，不仅是插件自读自写。
- `.comp`保存16位PNG及文档位深，图层和蒙版往返保留16位分量。
- 显示/缩略图、JPEG/WebP是明确的8位量化边界，量化副本不写回高精度图层。
- TIFF 16位读取不再提前舍入，修复RGB逐通道水平预测和16位字节序/进位；有符号或浮点TIFF明确拒绝，不静默当作无符号8位处理。

选区轮廓仍是既有8位覆盖率模型；它是选择权重，不是图层或蒙版的存储位深。16位工作精度不等于32位HDR，也不宣称已实现所有ICC工作流或真实Photoshop格式的全部变体。

## 中文化

可控菜单、参数、历史名称与第三方错误边界使用中文。新增 `userErrorMessage` 统一处理损坏文件、权限、内存等第三方异常；命令入口捕获异常并在状态栏提示，预览编码错误不会直接展示英文堆栈。

格式缩写、键名、字体名、文件名、图层名和用户输入保留原值，不将这些用户数据强制翻译。

## 验证资料

- `playwright-results.json`：整套浏览器回归原始结果（含旧8位回归）。
- `validation.json`：构建、回归、打包结果与包摘要。
- `source-hashes.json`：本次验证对应的本地源码字节摘要。
- `../results/remaining-completion.json`：三项关闭证据及测试名称。
- `实施计划.md`：执行检查点。

新增测试覆盖低预算裁剪、拒绝路径、独立PNG/PSD通道夹具、最低有效位、PNG/PSD/工程往返、透明度与蒙版、导入/粘贴、历史、中文错误及已发现的整数查表/舍入退化。

完成勾选表示对应审计问题在上述支持范围内修复并回归通过，**不是任意格式/所有平台/所有硬件的零缺陷保证**。

## 重跑

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm exec playwright test --workers=2 --reporter=json > docs/fixes/remaining/playwright-results.json
node --test scripts/*.test.mjs
node scripts/fixes/remaining-report.mjs
node scripts/fixes/progress.mjs
node scripts/pack-plugin.mjs --out dist-pack --version 0.1.0
python scripts/verify-plugin.py dist-pack --packid otools-compositor --version 0.1.0
```
