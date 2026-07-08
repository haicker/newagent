/**
 * 修复 multer 上传时中文文件名乱码问题
 * multer 以 latin1 编码处理文件名，需转换为 utf8
 */
export function decodeFileName(name: string): string {
  return Buffer.from(name, 'latin1').toString('utf8');
}
