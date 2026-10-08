# 第五轮 Review 修复进度

基线：插件 713dcbe，上游 fa41b9b。仅修复本轮 8 类缺陷，不改 PAT、不正式发布；版本保持 0.1.0，原有临时缓存不动。

按测试驱动顺序实施：先在 review-hierarchy.spec.ts 补失败用例；复用 editTarget 的矩阵映射处理滤镜/反相/蒙版选区；新增 layerHierarchy.ts 统一面板、合成与移动次序；标量属性历史按文档和图层 ID 回放，不保留会失效的图层对象引用。

- [x] 1. 空选区滤镜不执行、不写历史；覆盖全部破坏性滤镜入口。
- [x] 2. 滤镜结果统一按投影到图层网格的选区混合，保留灰度覆盖率和选区外像素。
- [x] 3. 图像/蒙版反相遵守选区、锁定和禁用状态，并原子记录历史、未保存标记。
- [x] 4. 蒙版启用开关进入统一属性历史，撤销重做和未保存状态正确。
- [x] 5. 从选区生成蒙版按实际变换采样，选区与新蒙版同一次撤销恢复。
- [x] 6. 面板和合成器使用同一层级次序，折叠状态不改变实际渲染。
- [x] 7. 上移/下移按同级整块子树移动，不再原地插回或只移动组头。
- [x] 8. 剪贴/可见性/蒙版开关等属性历史按 ID 查找当前对象，结构历史交错不丢状态。
- [x] 9. 构建通过；新增 30 项回归，全部 147 项 Playwright（workers=2）及 14 项发布脚本测试通过；0.1.0 oplg 已生成并独立校验。
- [x] 10. 修复提交 281e87e 已推送；Actions dry-run 37750767998 成功，正式发布任务已跳过。

范围：src/core/layerHierarchy.ts、src/core/engine/editTarget.ts、src/core/document.ts、src/core/engine/compositor.ts、src/composables/commands.ts、src/components/panels/LayersPanel.vue。测试只使用浏览器临时文档，不改用户工程。

CI：https://github.com/ijry/compositor-tauri/actions/runs/37750767998
本地包：dist-pack/otools-compositor-0.1.0.oplg；SHA256：F55639AE863704C80C9758D23EF6BB799B55E3A15A6D0EE05C77B5FFF488DA95。
