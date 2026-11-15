import type { PickedImage } from "./contracts";

const types: Record<string, string> = {
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", rtf: "application/rtf",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet", odp: "application/vnd.oasis.opendocument.presentation",
};
export const documentAccept = Object.keys(types).map(extension => `.${extension}`).join(",");
export function documentFile(file: PickedImage): PickedImage {
  const mime = types[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!mime || /[\\/\x00-\x1f]/.test(file.name) || file.name.length > 180) throw new Error("请选择 PDF、Office 或文本类文档。");
  if (!file.blob.size || file.blob.size > 100 * 1024 * 1024) throw new Error("文档需小于 100 MB，且不能为空。");
  return { name: file.name, blob: file.blob.slice(0, file.blob.size, mime) };
}
