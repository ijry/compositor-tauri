/** 面向用户的错误文案边界；内部标识/文件名不翻译，第三方异常不直接展示堆栈。 */
export function userErrorMessage(error:unknown):string {
  const message=error instanceof Error?error.message:typeof error==='string'?error:'';
  if(/[\u4e00-\u9fff]/.test(message))return message.slice(0,1000);
  if(/permission|access denied|notallowed|eacces|eperm/i.test(message))return '没有文件访问权限，请检查目录授权';
  if(/memory|allocation|out of memory|array length/i.test(message))return '可用内存不足，请减少图层或图像尺寸后重试';
  if(/invalid|signature|unexpected|offset|range|dataview|decode|decompress|unsupported|corrupt|truncat|end of file|buffer length/i.test(message))return '文件数据损坏或格式不支持，请检查文件是否完整';
  if(/not found|enoent|missing/i.test(message))return '所需文件不存在或已被移动，请重新选择文件';
  if(/abort|cancel/i.test(message))return '操作已取消，原文件未修改';
  if(/quota|enospc|disk.*full/i.test(message))return '存储空间不足，请释放磁盘空间后重试';
  return '操作未完成，请检查文件和设置后重试';
}
