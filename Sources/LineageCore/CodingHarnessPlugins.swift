import Foundation

public struct CodingHarnessDescriptor: Hashable, Identifiable {
    public var id: String
    public var displayName: String
    public var installLabel: String
    public var configurationRelativePath: String

    public init(id: String, displayName: String, installLabel: String, configurationRelativePath: String) {
        self.id = id
        self.displayName = displayName
        self.installLabel = installLabel
        self.configurationRelativePath = configurationRelativePath
    }
}

public protocol CodingHarnessPlugin {
    var descriptor: CodingHarnessDescriptor { get }
    var adapter: ProvenanceProviderAdapter { get }
    func hookConfiguration(command: String) -> String
}

public extension CodingHarnessPlugin {
    func configurationURL(repoRoot: URL) -> URL {
        repoRoot.appendingPathComponent(descriptor.configurationRelativePath)
    }

    func isConfigured(repoRoot: URL) -> Bool {
        FileManager.default.fileExists(atPath: configurationURL(repoRoot: repoRoot).path)
    }
}

public struct CodingHarnessPluginRegistry {
    public static let shared = CodingHarnessPluginRegistry(plugins: [
        CodexHarnessPlugin(),
        GitHubCopilotCLIHarnessPlugin()
    ])

    public let plugins: [CodingHarnessPlugin]
    private let pluginsByID: [String: CodingHarnessPlugin]

    public init(plugins: [CodingHarnessPlugin]) {
        self.plugins = plugins
        self.pluginsByID = Dictionary(uniqueKeysWithValues: plugins.map { ($0.descriptor.id, $0) })
    }

    public var descriptors: [CodingHarnessDescriptor] {
        plugins.map(\.descriptor)
    }

    public func plugin(for id: String) -> CodingHarnessPlugin? {
        pluginsByID[id]
    }

    public func configuredDescriptors(repoRoot: URL) -> [CodingHarnessDescriptor] {
        plugins.filter { $0.isConfigured(repoRoot: repoRoot) }.map(\.descriptor)
    }
}

public struct CodexHarnessPlugin: CodingHarnessPlugin {
    public let descriptor = CodingHarnessDescriptor(
        id: AIProvider.codex.id,
        displayName: AIProvider.codex.displayName,
        installLabel: "Install Codex Capture",
        configurationRelativePath: ".codex/config.toml"
    )

    public var adapter: ProvenanceProviderAdapter { CodexProviderAdapter() }

    public init() {}

    public func hookConfiguration(command: String) -> String {
        HookConfig.codexConfig(command: command)
    }
}

public struct GitHubCopilotCLIHarnessPlugin: CodingHarnessPlugin {
    public let descriptor = CodingHarnessDescriptor(
        id: AIProvider.githubCopilot.id,
        displayName: "GitHub Copilot CLI",
        installLabel: "Install Copilot Capture",
        configurationRelativePath: ".github/hooks/lineage-copilot.json"
    )

    public var adapter: ProvenanceProviderAdapter { GitHubCopilotProviderAdapter() }

    public init() {}

    public func hookConfiguration(command: String) -> String {
        HookConfig.githubCopilotCLIConfig(command: command)
    }
}
