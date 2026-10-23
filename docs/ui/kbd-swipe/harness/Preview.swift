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
  let scene = CommandLine.arguments.contains("--pairing") ? "pairing" : CommandLine.arguments.contains("--first-spend") ? "first-spend" : "composer"
  let mode = CommandLine.arguments.contains("--starts-now") ? "starts-now" : CommandLine.arguments.contains("--may-start-now") ? "may-start-now" : "owner"
  web.load(URLRequest(url: URL(string:"http://127.0.0.1:1437/.cache/kbd/preview.html?lang=\(lang)&scene=\(scene)&mode=\(mode)")!))
  Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
   self.web.evaluateJavaScript("JSON.stringify({viewport:{height:visualViewport.height,top:visualViewport.offsetTop,scale:visualViewport.scale,inner:innerHeight},keyboard:document.documentElement.dataset.keyboardOpen,typing:window.keyboardTypingEvidence,focused:document.activeElement.tagName,elements:[...document.querySelectorAll('#root,.cc,.composer,.stream,.stream .msg:last-child,[data-first-spend-sheet],[data-first-spend-keyboard-summary],[data-first-spend-keyboard-daily],[data-first-spend-keyboard-cost],[data-first-spend-amount],[data-first-spend-allow],[data-first-spend-cancel],.phone-onboarding,.phone-options input,.phone-options form button')].map(el=>({tag:el.tagName,cls:el.className,text:el.closest('[data-first-spend-keyboard-summary]')?el.textContent:undefined,rect:el.getBoundingClientRect().toJSON(),client:el.clientHeight,scroll:el.scrollHeight,scrollTop:el.scrollTop}))})") { value, error in
    if let text = value as? String { try? text.write(to: FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("geometry.json"), atomically:true, encoding:.utf8) }
   }
  }
 }
}
