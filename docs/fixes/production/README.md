# 两项生产阻断问题修复

基线 `6964059`；原74项审计及249项测试通过不代表生产验收完成。本次仅处理后续实际复现的两项错误，原始历史证据不覆盖。

## PROD-001：调整层效果在PSD导出中丢失

**原错误**：单独渲染调整层时没有下方图像，输出透明像素层。8位和16位均会丢失已在画布上生效的调整。

**处理方式**：

- 无调整层的工程保持原有分层PSD导出。
- 含任意调整层的工程，先显示兼容性确认，明确当前PSD将导出为一张包含完整可见效果的合成像素层；调整层、组、蒙版、隐藏层和画布外内容不会保持可编辑结构。
- 用户取消兼容性确认或保存对话框，不写文件、不触发额外浏览器下载，不修改源工程。
- 底层 `exportPsd(document)` 在有调整层时拒绝隐式降级；脚本调用必须显式传 `{ rasterizeAdjustments: true }`。
- 编码与提示使用同一文档快照，确认期间切换标签或编辑原图，不会把另一份内容误导出。
- 覆盖12类调整、8/16位、组透明度/蒙版、半透明内容及隐藏层，使用独立ag-psd读取器检查输出文件像素，而非仅检查按钮触发。

**仍有限制**：这是明确提示后的栅格化兼容导出，不是原生可编辑PSD调整层支持。需要继续编辑的工程应保存`.comp`。本修复不能当作“可无损交付任何复杂PSD”的承诺。

## PROD-002：RAW滤镜裁剪后拉伸回旧尺寸

**原错误**：仅替换输出像素，不更新图层变换；裁剪后的较小图像被缩放到原图框，且裁剪后可能绕过旧选区限制。

**处理方式**：

- 预览结果使用 `FilterPreviewResult { buffer, sourceRect }`，把实际编辑设置产生的源区域传给应用事务；不会再读取会话旧设置来猜测裁剪偏移。
- 应用时更新图层位置与尺寸；旋转/翻转保持原方向，透视扭曲按保留区域重建四角单应映射。
- 链接蒙版裁剪对应区域并保留采样密度；独立蒙版维持原文档位置。
- 颜色调整的选区覆盖率按原图坐标映射到输出，保留透明度混合。
- 非有限/负数/裁空图像的边距明确报错。导入RAW的显影面板也显示错误并禁用应用，避免共享解码校验抛出未捕获界面异常。
- 预览/取消不改图，一次撤销/重做恢复像素、几何与蒙版；文档切换、源层变化或重复应用时拒绝过期结果。

## 验证与资料

- [x] PROD-001：PSD兼容导出与确认/取消，32项专项通过。
- [x] PROD-002：RAW裁剪及相关回放保护，25项专项通过。
- [x] 完整306项浏览器回归、14项发布脚本测试、构建及本地包校验通过。


- `baseline-red.json`：在已提交的6964059基线上复跑专项用例；已排除浏览器缺失/Node画布初始化等测试环境错误。
- `playwright-results.json`：修复后的完整回归，包含旧249项与本次新增的57项。
- `validation.json`：最终执行结果和本地插件包摘要。
- `修复计划.md`：逐项进度。

新增回归位于 `tests/layout/psd-adjustment-export.spec.ts` 和 `tests/layout/raw-filter-crop.spec.ts`。截图/数学映射只证明所列场景；未替代真实OTools、Photoshop、相机RAW文件和多平台实机验收。

**当前定位仍是需要受控试用的插件**，不能把这两项错误修好再次扩大为“所有功能生产可用”。既有格式限制（如CMYK、32位HDR、CR3/RAF及部分压缩RAW）不在本次修复范围。

## 重跑

```powershell
pnpm exec playwright install chromium
pnpm build
pnpm exec playwright test --workers=2 --reporter=json > docs/fixes/production/playwright-results.json
node --test scripts/*.test.mjs
node scripts/pack-plugin.mjs --out dist-pack --version 0.1.0
python scripts/verify-plugin.py dist-pack --packid otools-compositor --version 0.1.0
```

本目录的 `validation.json` 是修复完成、提交发布前的本地验证快照（0.1.0测试包），其中提交状态和包摘要仅描述当时结果。后续0.0.1提交发布状态见[发布验证记录](../../releases/0.0.1-validation.json)。
