import Capacitor
import UIKit
import Photos
import UniformTypeIdentifiers

@objc(DoneBotDocumentsPlugin)
class DoneBotDocumentsPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    let identifier = "DoneBotDocumentsPlugin"
    let jsName = "DoneBotDocuments"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveToPhotos", returnType: CAPPluginReturnPromise)
    ]
    private var pending: CAPPluginCall?

    private func attachmentURL(_ call: CAPPluginCall) -> URL? {
        guard let raw = call.getString("uri"), let url = URL(string: raw), url.isFileURL,
              let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            call.reject("Invalid attachment")
            return nil
        }
        let root = cache.appendingPathComponent("donebot-media", isDirectory: true).resolvingSymlinksInPath().path + "/"
        guard url.resolvingSymlinksInPath().path.hasPrefix(root), FileManager.default.fileExists(atPath: url.path) else {
            call.reject("Invalid attachment location")
            return nil
        }
        return url
    }

    @objc func saveToPhotos(_ call: CAPPluginCall) {
        guard let url = attachmentURL(call) else { return }
        guard let kind = call.getString("kind"), kind == "image" || kind == "video" else {
            call.reject("请选择图片或视频。")
            return
        }
        DispatchQueue.main.async {
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                guard status == .authorized || status == .limited else {
                    call.reject("请在系统设置中允许 DoneBot 添加照片，才能保存到图库。", "PHOTO_PERMISSION_DENIED")
                    return
                }
                let category: UTType = kind == "video" ? .movie : .image
                let mimeType = call.getString("mime").flatMap { UTType(mimeType: $0) }
                let fileType = UTType(filenameExtension: url.pathExtension)
                let mediaType = [mimeType, fileType].compactMap { $0 }.first { $0.conforms(to: category) }
                var importURL = url
                // PhotoKit also checks the file extension, even when the UTI is supplied.
                if let type = mediaType, let ext = type.preferredFilenameExtension,
                   !(fileType?.conforms(to: type) ?? false) {
                    importURL = url.deletingLastPathComponent().appendingPathComponent(UUID().uuidString + "." + ext)
                    do { try FileManager.default.copyItem(at: url, to: importURL) }
                    catch {
                        call.reject("未能准备图库文件，请检查手机可用存储空间。", "PHOTO_SAVE_FAILED")
                        return
                    }
                }
                let resourceURL = importURL
                PHPhotoLibrary.shared().performChanges({
                    let asset = PHAssetCreationRequest.forAsset()
                    let options = PHAssetResourceCreationOptions()
                    options.uniformTypeIdentifier = mediaType?.identifier
                    asset.addResource(with: kind == "video" ? .video : .photo, fileURL: resourceURL, options: options)
                }) { success, _ in
                    if resourceURL != url { try? FileManager.default.removeItem(at: resourceURL) }
                    if success { call.resolve() }
                    else { call.reject("未能保存到图库，请检查文件格式和手机可用存储空间。", "PHOTO_SAVE_FAILED") }
                }
            }
        }
    }

    @objc func save(_ call: CAPPluginCall) {
        guard let url = attachmentURL(call) else { return }
        DispatchQueue.main.async {
            guard self.pending == nil, let presenter = self.bridge?.viewController else {
                call.reject("A file action is already open")
                return
            }
            self.pending = call
            let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
            picker.delegate = self
            picker.modalPresentationStyle = .formSheet
            presenter.present(picker, animated: true)
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        pending?.resolve()
        pending = nil
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pending?.resolve()
        pending = nil
    }
}
