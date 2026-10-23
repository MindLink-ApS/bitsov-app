import UIKit
import WebKit
@main class AppDelegate: UIResponder, UIApplicationDelegate {
 func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
  let config = UISceneConfiguration(name: "Preview", sessionRole: session.role)
  config.delegateClass = SceneDelegate.self
  return config
 }
}
class SceneDelegate: UIResponder, UIWindowSceneDelegate, WKNavigationDelegate {
 var window: UIWindow?
 var web: WKWebView!
 func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
  guard let windowScene = scene as? UIWindowScene else { return }
  window = UIWindow(windowScene: windowScene)
  let vc = UIViewController()
  web = WKWebView(frame: window!.bounds)
  web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
  web.scrollView.contentInsetAdjustmentBehavior = .never
  web.allowsBackForwardNavigationGestures = false // same as locked Tauri/Wry
  web.navigationDelegate = self
  vc.view = web
  window!.rootViewController = vc
  window!.makeKeyAndVisible()
  let lang = CommandLine.arguments.contains("--da") ? "da" : "en"
  let page = CommandLine.arguments.first(where: { $0.hasPrefix("--scene=") })?.replacingOccurrences(of:"--scene=",with:"") ?? "chat"
  web.load(URLRequest(url: URL(string:"http://127.0.0.1:1438/docs/ui/u2b-dynamic-type/harness/preview.html?lang=\(lang)&scene=\(page)")!))
  Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
   self.web.evaluateJavaScript("JSON.stringify(window.dynamicTypeGeometry?.())") { value, error in
    if let text = value as? String { try? text.write(to: FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("geometry.json"), atomically:true, encoding:.utf8) }
   }
  }
 }
}
