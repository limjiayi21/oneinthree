// One in Three: AirPods head tracking helper (macOS 14+).
//
// Browsers cannot read headphone motion, so this tiny menu-bar app reads the
// AirPods' head attitude with CMHeadphoneMotionManager and streams it to the
// game over a local WebSocket: ws://127.0.0.1:8765 (this machine only).
//
// Messages (JSON text):
//   {"type":"status","airpods":"connected"|"disconnected"|"unavailable","auth":"authorized"|"denied"|"restricted"|"notDetermined"}
//   {"type":"motion","yaw":rad,"pitch":rad,"roll":rad,"t":seconds}
//
// Build and run with `npm run airpods` (tools/airpods-helper/build.sh).

import AppKit
import CoreMotion
import Network

let PORT: UInt16 = 8765

final class Helper: NSObject, CMHeadphoneMotionManagerDelegate {
    private let motion = CMHeadphoneMotionManager()
    private let queue = DispatchQueue(label: "oneinthree.airpods")
    private var listener: NWListener?
    private var clients: [ObjectIdentifier: NWConnection] = [:]
    private var airpods = "disconnected"
    private var lastSent: TimeInterval = 0
    private var statusItem: NSStatusItem?
    private let statusLine = NSMenuItem(title: "AirPods: waiting", action: nil, keyEquivalent: "")

    func start() {
        setUpMenu()
        startServer()
        motion.delegate = self
        guard motion.isDeviceMotionAvailable else {
            airpods = "unavailable"
            broadcastStatus()
            return
        }
        motion.startDeviceMotionUpdates(to: OperationQueue()) { [weak self] data, _ in
            guard let self, let data else { return }
            let now = ProcessInfo.processInfo.systemUptime
            if now - self.lastSent < 1.0 / 60.0 { return }
            self.lastSent = now
            if self.airpods != "connected" {
                self.airpods = "connected"
                self.broadcastStatus()
            }
            let a = data.attitude
            self.broadcast(String(format: "{\"type\":\"motion\",\"yaw\":%.5f,\"pitch\":%.5f,\"roll\":%.5f,\"t\":%.3f}", a.yaw, a.pitch, a.roll, now))
        }
    }

    // MARK: AirPods connection

    func headphoneMotionManagerDidConnect(_ manager: CMHeadphoneMotionManager) {
        airpods = "connected"
        broadcastStatus()
    }

    func headphoneMotionManagerDidDisconnect(_ manager: CMHeadphoneMotionManager) {
        airpods = "disconnected"
        broadcastStatus()
    }

    private func authText() -> String {
        switch CMHeadphoneMotionManager.authorizationStatus() {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        default: return "notDetermined"
        }
    }

    private func statusJSON() -> String {
        "{\"type\":\"status\",\"airpods\":\"\(airpods)\",\"auth\":\"\(authText())\"}"
    }

    private func broadcastStatus() {
        broadcast(statusJSON())
        let text = "AirPods: \(airpods) · \(clients.count) game\(clients.count == 1 ? "" : "s") listening"
        DispatchQueue.main.async { self.statusLine.title = text }
    }

    // MARK: WebSocket server (loopback only)

    /// The game, served locally (any port), from oneinthree.nyc, or from its Cloudflare Workers address.
    static func allowedOrigin(_ origin: String) -> Bool {
        guard let url = URL(string: origin), let host = url.host?.lowercased() else { return false }
        if host == "localhost" || host == "127.0.0.1" || host == "::1" { return true }
        guard url.scheme == "https" else { return false }
        // The game's own domain (and www), or its Cloudflare Workers address.
        if host == "oneinthree.nyc" || host == "www.oneinthree.nyc" { return true }
        return host.hasPrefix("oneinthree.") && host.hasSuffix(".workers.dev")
    }

    private func startServer() {
        let params = NWParameters.tcp
        params.acceptLocalOnly = true
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        // Only the game may read head motion: refuse pages from any other website. (acceptLocalOnly
        // above already refuses other machines.) No Origin header means a local tool, not a web page.
        ws.setClientRequestHandler(queue) { _, headers in
            let origin = headers.first { $0.name.lowercased() == "origin" }?.value
            let ok = origin.map(Helper.allowedOrigin) ?? true
            if !ok { NSLog("AirPods helper: refused a connection from \(origin ?? "")") }
            return NWProtocolWebSocket.Response(status: ok ? .accept : .reject, subprotocol: nil)
        }
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        do {
            let l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: PORT)!)
            l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
            l.stateUpdateHandler = { state in
                if case .failed(let err) = state { NSLog("AirPods helper: listener failed: \(err)") }
            }
            l.start(queue: queue)
            listener = l
            NSLog("AirPods helper: listening on ws://127.0.0.1:\(PORT)")
        } catch {
            NSLog("AirPods helper: could not listen on \(PORT): \(error)")
        }
    }

    private func accept(_ conn: NWConnection) {
        let id = ObjectIdentifier(conn)
        conn.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.clients[id] = conn
                self.send(self.statusJSON(), to: conn)
                self.broadcastStatus()
                self.receive(on: conn)
            case .failed, .cancelled:
                self.clients[id] = nil
                self.broadcastStatus()
            default:
                break
            }
        }
        conn.start(queue: queue)
    }

    /// Keep reading so a closed socket is noticed; the game sends nothing we need.
    private func receive(on conn: NWConnection) {
        conn.receiveMessage { [weak self] _, _, _, error in
            if error != nil { conn.cancel(); return }
            self?.receive(on: conn)
        }
    }

    private func send(_ text: String, to conn: NWConnection) {
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let ctx = NWConnection.ContentContext(identifier: "msg", metadata: [meta])
        conn.send(content: text.data(using: .utf8), contentContext: ctx, isComplete: true, completion: .idempotent)
    }

    private func broadcast(_ text: String) {
        queue.async {
            for conn in self.clients.values { self.send(text, to: conn) }
        }
    }

    // MARK: Menu bar

    private func setUpMenu() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "🎧"
        item.button?.toolTip = "One in Three: AirPods head tracking"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "One in Three: AirPods head tracking", action: nil, keyEquivalent: ""))
        menu.addItem(statusLine)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
        item.menu = menu
        statusItem = item
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let helper = Helper()
helper.start()
app.run()
