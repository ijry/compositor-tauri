# 第四轮 Review 修复进度

基线：插件 64fe873，上游 bba92dc。只修复本轮 9 类问题；保持版本 0.1.0，不改 PAT，不正式发布，原有临时缓存不动。

执行方式：先用 tests/layout/review-editing.spec.ts 复现失败；按子任务实现并回归，完成一项勾选一项。拆分像素编辑目标/选区映射与剪贴板数据模型，合成保持上游“通过式组”和“共享基础 alpha 的剪贴栈”两种语义，不混为一谈。

- [x] 1. 粘贴隔离：每次复制/粘贴持有独立快照，多个粘贴层及剪贴板互不污染，撤销只影响目标层。
- [x] 2. 编辑目标：填充、清除、模糊共用图像/蒙版目标和坐标映射；不能支持蒙版的工具明确拒绝，不能偷偷改写图像。
- [x] 3. 区域模糊：修正局部/全局索引，加入越界和空矩形保护，保持透明度与颜色。
- [x] 4. 混合模式：统一 W3C 非预乘 RGBA 源覆盖公式，背景透明时保留源颜色。
- [x] 5. 剪贴栈：先合成颜色，最后恢复基础 alpha，组蒙版只应用一次；保留通过式组语义。
- [x] 6. 选区坐标：按目标完整变换投影到文档选区，填充和清除兼容缩放/旋转/独立蒙版。
- [x] 7. 普通复制：无选区复制活动图层/组快照，有选区只复制活动目标像素，与复制合并区分。
- [x] 8. 复制合并：按选区裁剪并保留原位置和灰度覆盖率；空选区不复制整张图像。
- [x] 9. 灰度清除：仅降低图像 alpha，不重复缩暗非预乘 RGB；蒙版清除填充背景灰度。
- [x] 10. 本地构建通过；新增 27 项回归，全部 117 项 Playwright 与 14 项发布脚本测试通过；0.1.0 本地插件包已生成并独立校验。
- [x] 11. 修复提交 139cf1e 已推送；GitHub Actions dry-run 37733687025 成功，正式发布任务已跳过。

主要文件：src/core/engine/editTarget.ts、src/core/clipboard.ts、src/core/blend.ts、src/core/engine/compositor.ts、src/core/filters/blur.ts、src/tools/paint.ts、src/composables/commands.ts。测试只使用临时浏览器文档，不改真实工程。

CI：https://github.com/ijry/compositor-tauri/actions/runs/37733687025
本地包：dist-pack/otools-compositor-0.1.0.oplg；SHA256：C57FB270A08B6E4423C2CF03A0684F9DF0AB94977974172FA867F917F8AE8226。
