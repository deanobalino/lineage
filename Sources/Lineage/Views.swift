import SwiftUI
import AppKit
import LineageCore

struct RootView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        ZStack {
            if state.projects.isEmpty && state.repository == nil {
                WelcomeView()
            } else {
                AppWorkspaceView()
            }
            if state.isLoadingRepository {
                LoadingOverlay(message: "Loading repository")
            }
        }
        .preferredColorScheme(.dark)
        .background(Color.lineageBackground)
    }
}

struct AppWorkspaceView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        HStack(spacing: 0) {
            ProjectLibraryPane()
                .frame(width: state.projectPaneCollapsed ? 58 : 244)
            Divider()
                .overlay(Color.white.opacity(0.08))
            Group {
                if state.repository == nil {
                    ProjectSelectionPlaceholder()
                } else {
                    MainLayoutView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color.lineageBackground)
        .task {
            state.restoreInitialProjectIfNeeded()
        }
    }
}

struct ProjectLibraryPane: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if state.projectPaneCollapsed {
                VStack(spacing: 8) {
                    AppIconMark(size: 32)
                    Button(action: state.toggleProjectPane) {
                        Image(systemName: "sidebar.left")
                    }
                    .buttonStyle(IconButtonStyle())
                    .help("Show projects")
                }
            } else {
                HStack(spacing: 9) {
                    AppIconMark(size: 30)
                    Text("Lineage")
                        .font(.headline)
                    Spacer()
                    Button(action: state.toggleProjectPane) {
                        Image(systemName: "sidebar.left")
                    }
                    .buttonStyle(IconButtonStyle())
                    .help("Hide projects")
                    Button(action: state.chooseRepository) {
                        Image(systemName: "plus")
                    }
                    .buttonStyle(IconButtonStyle())
                    .help("Add repository")
                }
            }

            if state.projectPaneCollapsed {
                CollapsedProjectList()
            } else {
                ExpandedProjectList()
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, state.projectPaneCollapsed ? 9 : 14)
        .padding(.vertical, 16)
        .background(Color.black.opacity(0.12))
    }
}

struct AppIconMark: View {
    var size: CGFloat

    var body: some View {
        Group {
            if let image = Self.image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            } else {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: size * 0.62, weight: .semibold))
                    .foregroundStyle(Color.green)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.white.opacity(0.12)))
        .shadow(color: .black.opacity(0.22), radius: 8, y: 4)
        .accessibilityLabel("Lineage")
    }

    private static var image: NSImage? {
        guard let url = Bundle.module.url(forResource: "LineageAppIcon", withExtension: "png") else {
            return nil
        }
        return NSImage(contentsOf: url)
    }
}

struct ExpandedProjectList: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 4) {
                ForEach(state.projects) { project in
                    ProjectRow(project: project)
                }
            }
            .padding(.vertical, 2)
        }
        .scrollIndicators(.visible)
    }
}

struct CollapsedProjectList: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        VStack(spacing: 8) {
            Button(action: state.chooseRepository) {
                Image(systemName: "plus")
            }
            .buttonStyle(IconButtonStyle())
            .help("Add repository")

            ForEach(state.projects) { project in
                Button {
                    state.openProject(project)
                } label: {
                    Text(projectInitials(project.name))
                        .font(.caption.weight(.semibold))
                        .frame(width: 32, height: 32)
                        .background(state.activeProjectPath == project.path ? Color.accentColor.opacity(0.28) : Color.white.opacity(0.07))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.10)))
                }
                .buttonStyle(.plain)
                .help(project.name)
            }
        }
    }
}

struct ProjectRow: View {
    @EnvironmentObject private var state: AppState
    var project: ProjectBookmark

    var body: some View {
        HStack(spacing: 4) {
            Button {
                state.openProject(project)
            } label: {
                HStack(spacing: 9) {
                    Image(systemName: state.activeProjectPath == project.path ? "folder.fill" : "folder")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(state.activeProjectPath == project.path ? Color.accentColor : Color.secondary)
                        .frame(width: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(project.name)
                            .font(.system(size: 13, weight: .semibold))
                            .lineLimit(1)
                        Text(project.path)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button {
                state.removeProject(project)
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(ProjectRemoveButtonStyle())
            .help("Remove project from Lineage")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .frame(minHeight: 44)
        .background(state.activeProjectPath == project.path ? Color.accentColor.opacity(0.18) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct ProjectRemoveButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 10, weight: .bold))
            .frame(width: 24, height: 24)
            .background(Color.white.opacity(configuration.isPressed ? 0.14 : 0.06))
            .foregroundStyle(.secondary)
            .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

struct ProjectSelectionPlaceholder: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "folder.badge.gearshape")
                .font(.system(size: 38, weight: .medium))
                .foregroundStyle(.secondary)
            VStack(spacing: 6) {
                Text("Choose a project")
                    .font(.title2.weight(.semibold))
                Text("Select a repository from the project pane or add another one.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Button(action: state.chooseRepository) {
                Label("Add Repository", systemImage: "plus")
            }
            .buttonStyle(PrimaryButtonStyle())
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.lineageBackground)
    }
}

private func projectInitials(_ name: String) -> String {
    let words = name
        .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        .map(String.init)
    let initials = words.prefix(2).compactMap(\.first).map { String($0).uppercased() }.joined()
    return initials.isEmpty ? "?" : initials
}

struct WelcomeView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        GeometryReader { proxy in
            let dividerWidth: CGFloat = 1
            let leftWidth = min(500, max(360, proxy.size.width * 0.34))
            let previewWidth = max(0, proxy.size.width - leftWidth - dividerWidth)
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 28) {
                    Spacer(minLength: 34)

                    VStack(alignment: .leading, spacing: 14) {
                        Text("Lineage")
                            .font(.system(size: min(68, max(48, proxy.size.width * 0.045)), weight: .semibold, design: .default))
                        Text("Every line has a story.")
                            .font(.title2.weight(.medium))
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Git blame tells you who.")
                            Text("Lineage tells you why.")
                        }
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.primary)
                    }

                    Text("Farm-to-fork provenance for AI-generated code.")
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.tertiary)

                    ViewThatFits(in: .horizontal) {
                        WelcomeActions(horizontal: true)
                        WelcomeActions(horizontal: false)
                    }

                    Spacer()

                    HStack(spacing: 18) {
                        WelcomeStat(value: "Review", label: "branch changes")
                        WelcomeStat(value: "Trace", label: "provider evidence")
                        WelcomeStat(value: "Explain", label: "changed lines")
                    }
                }
                .padding(.leading, 56)
                .padding(.trailing, 34)
                .padding(.vertical, 54)
                .frame(width: leftWidth, alignment: .leading)
                .clipped()

                Divider()
                    .overlay(Color.white.opacity(0.08))

                ZStack(alignment: .topLeading) {
                    WelcomePreview()
                        .padding(.leading, 24)
                        .padding(.trailing, 28)
                        .padding(.vertical, 44)
                }
                    .frame(width: previewWidth, height: proxy.size.height)
                    .clipped()
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .background(Color.lineageBackground)
        }
    }
}

struct WelcomeActions: View {
    @EnvironmentObject private var state: AppState
    var horizontal: Bool

    var body: some View {
        Group {
            if horizontal {
                HStack(spacing: 12) { buttons }
            } else {
                VStack(alignment: .leading, spacing: 10) { buttons }
            }
        }
    }

    @ViewBuilder
    private var buttons: some View {
        Button(action: state.chooseRepository) {
            Label("Open Repository", systemImage: "folder")
                .frame(minWidth: 180)
        }
        .buttonStyle(PrimaryButtonStyle())
        Button(action: state.openDemoRepository) {
            Label("Open Demo Repository", systemImage: "play.circle")
                .frame(minWidth: 206)
        }
        .buttonStyle(SecondaryButtonStyle())
    }
}

struct WelcomeStat: View {
    var value: String
    var label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
            Text(label)
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .frame(minWidth: 96, alignment: .leading)
    }
}

struct WelcomePreview: View {
    var body: some View {
        GeometryReader { proxy in
            let fileWidth = min(220, max(150, proxy.size.width * 0.28))
            let explanationWidth = min(240, max(170, proxy.size.width * 0.28))
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Review Branch")
                            .font(.headline)
                        Text("feature/auth-hardening ... main")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer()
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) {
                            Pill("Captured from Codex", color: .green)
                            Pill("Git mapped", color: .blue)
                        }
                        Pill("Captured from Codex", color: .green)
                    }
                }

                HStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 12) {
                        PreviewMetric(value: "8", label: "files")
                        PreviewFile(status: "M", name: "Sources/Auth/RetryPolicy.swift", selected: true)
                        PreviewFile(status: "A", name: "Tests/AuthRetryTests.swift", selected: false)
                        PreviewFile(status: "M", name: "README.md", selected: false)
                        Spacer()
                    }
                    .frame(width: fileWidth)
                    .padding(14)
                    .background(Color.black.opacity(0.16))

                    Divider().overlay(Color.white.opacity(0.08))

                    VStack(alignment: .leading, spacing: 0) {
                        PreviewCodeLine(kind: "hunk", old: "", new: "", text: "@@ -12,6 +12,8 @@")
                        PreviewCodeLine(kind: "context", old: "12", new: "12", text: "let transientErrors = [...]")
                        PreviewCodeLine(kind: "addition", old: "", new: "13", text: "let maxAuthRetries = 7")
                        PreviewCodeLine(kind: "addition", old: "", new: "14", text: "guard retries <= maxAuthRetries else {")
                        PreviewCodeLine(kind: "context", old: "13", new: "15", text: "    throw AuthenticationBackoffExceeded()")
                        Spacer()
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Color.codeBackground)

                    Divider().overlay(Color.white.opacity(0.08))

                    VStack(alignment: .leading, spacing: 12) {
                        Text("Why did this change happen?")
                            .font(.headline)
                            .lineLimit(2)
                        Text("Linked to recorded provider provenance and a bounded-auth decision.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        VStack(alignment: .leading, spacing: 8) {
                            Pill("Human selected", color: .green)
                            Pill("Tests captured", color: .blue)
                            Pill("External constraint", color: .orange)
                        }
                        Spacer()
                    }
                    .frame(width: explanationWidth)
                    .padding(14)
                    .background(Color.panel.opacity(0.62))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.08)))
                .shadow(color: .black.opacity(0.28), radius: 24, y: 18)
            }
        }
    }
}

struct PreviewMetric: View {
    var value: String
    var label: String

    var body: some View {
        HStack {
            Text(value)
                .font(.title3.monospacedDigit().weight(.semibold))
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
    }
}

struct PreviewFile: View {
    var status: String
    var name: String
    var selected: Bool

    var body: some View {
        HStack(spacing: 8) {
            Text(status)
                .font(.caption.monospaced().weight(.bold))
                .foregroundStyle(status == "A" ? Color.green : Color.orange)
                .frame(width: 18)
            Text(name)
                .font(.caption)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(selected ? Color.accentColor.opacity(0.20) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

struct PreviewCodeLine: View {
    var kind: String
    var old: String
    var new: String
    var text: String

    var body: some View {
        HStack(spacing: 8) {
            Text(old)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.tertiary)
                .frame(width: 28, alignment: .trailing)
            Text(new)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.tertiary)
                .frame(width: 28, alignment: .trailing)
            Text(prefix)
                .font(.caption.monospaced())
                .foregroundStyle(prefixColor)
                .frame(width: 10)
            Text(text)
                .font(.caption.monospaced())
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(background)
    }

    private var prefix: String {
        switch kind {
        case "addition": return "+"
        case "deletion": return "-"
        default: return " "
        }
    }

    private var prefixColor: Color {
        kind == "addition" ? .green : .secondary
    }

    private var background: Color {
        switch kind {
        case "addition": return Color.green.opacity(0.10)
        case "hunk": return Color.cyan.opacity(0.08)
        default: return Color.clear
        }
    }
}

struct MainLayoutView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        HStack(spacing: 0) {
            SidebarView()
                .frame(width: CGFloat(state.sidebarWidth))
            PaneResizeHandle(kind: .sidebar)
            Group {
                if state.workspaceMode == "review" {
                    ReviewDiffPaneView()
                } else {
                    CodePaneView()
                }
            }
                .frame(minWidth: 420, maxWidth: .infinity)
            PaneResizeHandle(kind: .right)
            Group {
                if state.workspaceMode == "review" {
                    ReviewExplanationPaneView()
                } else {
                    ExplanationPaneView()
                }
            }
                .frame(width: CGFloat(state.rightPaneWidth))
        }
        .background(Color.lineageBackground)
        .sheet(item: $state.selectedSessionPivot) { session in
            SessionDetailPivotView(session: session)
                .environmentObject(state)
                .frame(minWidth: 820, minHeight: 640)
        }
    }
}

struct SidebarView: View {
    @EnvironmentObject private var state: AppState
    @State private var showProvenance = false
    @State private var showCaptureStatus = false

    var visibleFiles: [RepoFile] {
        guard let repository = state.repository else { return [] }
        if state.searchText.isEmpty { return repository.files }
        return repository.files.filter { $0.path.localizedCaseInsensitiveContains(state.searchText) }
    }

    var fileTree: [FileTreeNode] {
        FileTreeNode.makeTree(from: visibleFiles)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let repo = state.repository {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(repo.name)
                                .font(.title3.weight(.semibold))
                            Text(repo.root.path)
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer()
                        Button(action: state.toggleProjectPane) {
                            Image(systemName: "sidebar.left")
                        }
                        .buttonStyle(IconButtonStyle())
                        .help(state.projectPaneCollapsed ? "Show projects" : "Hide projects")
                    }
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.triangle.branch")
                            .foregroundStyle(.secondary)
                        Picker("Branch", selection: Binding(
                            get: { repo.branch },
                            set: { state.switchBranch(to: $0) }
                        )) {
                            ForEach(repo.branches, id: \.self) { branch in
                                Text(branch).tag(branch)
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(8)
                    .background(Color.black.opacity(0.18))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    Text(repo.latestCommit)
                        .font(.caption.monospaced())
                        .foregroundStyle(.tertiary)
                        .lineLimit(2)
                }
                Picker("Mode", selection: Binding(
                    get: { state.workspaceMode },
                    set: { state.setWorkspaceMode($0) }
                )) {
                    Text("Explore").tag("explore")
                    Text("Review").tag("review")
                }
                .pickerStyle(.segmented)
                HStack(spacing: 8) {
                    Spacer()
                    Button(action: state.refreshRepository) {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(IconButtonStyle())
                    .help("Refresh Git and Lineage provenance")
                    Button(action: state.exportAgentTrace) {
                        Image(systemName: "point.3.connected.trianglepath.dotted")
                    }
                    .buttonStyle(IconButtonStyle())
                    .help("Export Agent Trace JSONL")
                }
                if let branchMessage = state.branchMessage {
                    Text(branchMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                SearchField(text: $state.searchText)
            }

            if state.workspaceMode == "review" {
                ReviewSidebarContent()
                    .frame(maxHeight: .infinity)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Explorer")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text("\(visibleFiles.count)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 1) {
                            ForEach(fileTree) { node in
                                FileTreeRow(node: node, depth: 0)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .background(Color.black.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .frame(minHeight: 180, maxHeight: .infinity)
                .layoutPriority(1)

                if let repo = state.repository {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 10) {
                            DisclosureGroup(isExpanded: $showProvenance) {
                                ProvenanceSummaryView(summary: repo.provenanceSummary)
                                    .padding(.top, 6)
                            } label: {
                                SidebarDisclosureLabel(title: "AI provenance", value: "\(repo.provenanceSummary.sessionsCaptured)")
                            }
                            .disclosureGroupStyle(.automatic)

                            DisclosureGroup(isExpanded: $showCaptureStatus) {
                                CaptureStatusView(summary: repo.provenanceSummary)
                                    .padding(.top, 6)
                            } label: {
                                SidebarDisclosureLabel(title: "Capture status", value: captureStatusValue(repo.provenanceSummary))
                            }
                            .disclosureGroupStyle(.automatic)
                        }
                        .padding(.trailing, 2)
                    }
                    .frame(maxHeight: metadataMaxHeight)
                    .scrollIndicators(.visible)
                }
            }

            Button(action: state.installCodexCapture) {
                Label("Install Codex Capture", systemImage: "record.circle")
            }
            .buttonStyle(SecondaryButtonStyle())
            if let message = state.installMessage {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(20)
    }

    private func captureStatusValue(_ summary: ProvenanceSummary) -> String {
        if summary.eventsCaptured > 0 { return "active" }
        return summary.configured ? "ready" : "off"
    }

    private var metadataMaxHeight: CGFloat {
        showProvenance || showCaptureStatus ? 260 : 72
    }
}

struct ReviewSidebarContent: View {
    @EnvironmentObject private var state: AppState

    var groupedFiles: [(String, [ReviewChangedFile])] {
        let files = state.reviewSnapshot?.changedFiles ?? []
        let order = ["A", "M", "D", "R"]
        let groups = Dictionary(grouping: files) { String($0.status.prefix(1)) }
        return order.compactMap { key in
            guard let values = groups[key], !values.isEmpty else { return nil }
            return (key, values.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending })
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let repo = state.repository, !repo.branches.isEmpty {
                HStack(spacing: 8) {
                    Text("Head")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Picker("Head branch", selection: Binding(
                        get: { state.repository?.branch ?? repo.branch },
                        set: { state.switchBranch(to: $0) }
                    )) {
                        ForEach(repo.branches, id: \.self) { branch in
                            Text(branch).tag(branch)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .frame(maxWidth: .infinity)
                }
                .padding(8)
                .background(Color.black.opacity(0.18))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            if !state.reviewBaseBranches.isEmpty {
                HStack(spacing: 8) {
                    Text("Base")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Picker("Base branch", selection: Binding(
                        get: { state.reviewBaseBranch },
                        set: { state.switchReviewBase(to: $0) }
                    )) {
                        ForEach(state.reviewBaseBranches, id: \.self) { branch in
                            Text(branch).tag(branch)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .frame(maxWidth: .infinity)
                }
                .padding(8)
                .background(Color.black.opacity(0.18))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            if let summary = state.reviewSnapshot?.summary {
                ReviewMetricsView(summary: summary)
            }

            HStack {
                Text("Changed files")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Text("\(state.reviewSnapshot?.changedFiles.count ?? 0)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }

            if state.isLoadingReview && state.reviewSnapshot == nil {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading branch review...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 12)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(groupedFiles, id: \.0) { status, files in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(statusTitle(status))
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                                ForEach(files) { file in
                                    ReviewFileRow(file: file, selected: state.selectedReviewFile?.path == file.path)
                                }
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
                .background(Color.black.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    private func statusTitle(_ status: String) -> String {
        switch status {
        case "A": return "Added"
        case "M": return "Modified"
        case "D": return "Deleted"
        case "R": return "Renamed"
        default: return status
        }
    }
}

struct ReviewMetricsView: View {
    var summary: ReviewSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SummaryRow(value: "\(summary.filesChanged)", label: "files changed")
            SummaryRow(value: "\(summary.commitsOnBranch)", label: "commits on branch")
            SummaryRow(value: "\(summary.providerSessionsLinked)", label: "provider sessions linked")
            SummaryRow(value: "\(summary.filesWithRecordedProvenance)", label: "files with provenance")
            SummaryRow(value: "\(summary.filesInferredFromGitOnly)", label: "files inferred from Git")
        }
        .padding(10)
        .background(Color.panel)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.08)))
    }
}

struct ReviewFileRow: View {
    @EnvironmentObject private var state: AppState
    var file: ReviewChangedFile
    var selected: Bool

    var body: some View {
        Button {
            state.selectReviewFile(file)
        } label: {
            HStack(spacing: 8) {
                Text(String(file.status.prefix(1)))
                    .font(.caption.monospaced().weight(.bold))
                    .foregroundStyle(statusColor)
                    .frame(width: 16)
                Image(systemName: "doc.text")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(file.path)
                        .font(.system(size: 12.5))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if !file.providerSessions.isEmpty {
                        Text(file.providerSessions.map(\.providerDisplayName).joined(separator: ", "))
                            .font(.caption2)
                            .foregroundStyle(.green)
                    }
                }
                Spacer(minLength: 4)
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 5)
            .background(selected ? Color.accentColor.opacity(0.20) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var statusColor: Color {
        switch file.status.prefix(1) {
        case "A": return .green
        case "D": return .red
        case "R": return .blue
        default: return .orange
        }
    }
}

enum PaneResizeKind {
    case sidebar
    case right
}

struct PaneResizeHandle: View {
    @EnvironmentObject private var state: AppState
    var kind: PaneResizeKind
    @State private var startingWidth: Double?
    @State private var isHovering = false

    var body: some View {
        ZStack {
            Rectangle()
                .fill(isHovering ? Color.white.opacity(0.12) : Color.white.opacity(0.06))
            RoundedRectangle(cornerRadius: 4)
                .fill(isHovering ? Color.white.opacity(0.30) : Color.white.opacity(0.14))
                .frame(width: 2, height: isHovering ? 54 : 34)
            if isHovering {
                Image(systemName: "arrow.left.and.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .padding(5)
                    .background(Color.panel)
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                    .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.white.opacity(0.10)))
                    .offset(y: -34)
            }
        }
            .frame(width: 5)
            .contentShape(Rectangle())
            .onHover { hovering in
                isHovering = hovering
                if hovering {
                    NSCursor.resizeLeftRight.push()
                } else {
                    NSCursor.pop()
                }
            }
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        if startingWidth == nil {
                            startingWidth = currentWidth
                        }
                        let base = startingWidth ?? state.sidebarWidth
                        switch kind {
                        case .sidebar:
                            state.sidebarWidth = min(560, max(260, base + Double(value.translation.width)))
                        case .right:
                            state.resizeRightPane(startingWidth: base, translation: value.translation.width)
                        }
                    }
                    .onEnded { _ in
                        startingWidth = nil
                    }
            )
            .help(helpText)
    }

    private var currentWidth: Double {
        switch kind {
        case .sidebar: return state.sidebarWidth
        case .right: return state.rightPaneWidth
        }
    }

    private var helpText: String {
        switch kind {
        case .sidebar: return "Drag to resize file explorer"
        case .right: return "Drag to resize explanation pane"
        }
    }
}

struct SidebarDisclosureLabel: View {
    var title: String
    var value: String

    var body: some View {
        HStack {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
    }
}

struct FileTreeNode: Identifiable, Hashable {
    var id: String { path }
    var name: String
    var path: String
    var isDirectory: Bool
    var file: RepoFile?
    var children: [FileTreeNode]

    static func makeTree(from files: [RepoFile]) -> [FileTreeNode] {
        let root = MutableTreeNode(name: "", path: "", isDirectory: true)
        for file in files {
            root.insert(file: file)
        }
        return root.children
            .map { $0.frozen }
            .sorted(by: FileTreeNode.sort)
    }

    private static func sort(_ lhs: FileTreeNode, _ rhs: FileTreeNode) -> Bool {
        if lhs.isDirectory != rhs.isDirectory {
            return lhs.isDirectory && !rhs.isDirectory
        }
        return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
    }
}

private final class MutableTreeNode {
    var name: String
    var path: String
    var isDirectory: Bool
    var file: RepoFile?
    var children: [MutableTreeNode] = []

    init(name: String, path: String, isDirectory: Bool, file: RepoFile? = nil) {
        self.name = name
        self.path = path
        self.isDirectory = isDirectory
        self.file = file
    }

    func insert(file: RepoFile) {
        let parts = file.path.split(separator: "/").map(String.init)
        insert(parts: parts, fullPath: file.path, file: file)
    }

    private func insert(parts: [String], fullPath: String, file: RepoFile) {
        guard let first = parts.first else { return }
        let childPath = path.isEmpty ? first : "\(path)/\(first)"
        if parts.count == 1 {
            children.append(MutableTreeNode(name: first, path: fullPath, isDirectory: false, file: file))
            return
        }
        let directory = children.first { $0.path == childPath && $0.isDirectory } ?? {
            let node = MutableTreeNode(name: first, path: childPath, isDirectory: true)
            children.append(node)
            return node
        }()
        directory.insert(parts: Array(parts.dropFirst()), fullPath: fullPath, file: file)
    }

    var frozen: FileTreeNode {
        FileTreeNode(
            name: name,
            path: path,
            isDirectory: isDirectory,
            file: file,
            children: children.map { $0.frozen }.sorted(by: FileTreeNode.makeTreeSort)
        )
    }
}

private extension FileTreeNode {
    static func makeTreeSort(_ lhs: FileTreeNode, _ rhs: FileTreeNode) -> Bool {
        if lhs.isDirectory != rhs.isDirectory {
            return lhs.isDirectory && !rhs.isDirectory
        }
        return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
    }
}

struct FileTreeRow: View {
    @EnvironmentObject private var state: AppState
    var node: FileTreeNode
    var depth: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                if node.isDirectory {
                    state.toggleDirectory(node.path)
                } else if let file = node.file {
                    state.select(file: file)
                }
            } label: {
                HStack(spacing: 5) {
                    Color.clear
                        .frame(width: CGFloat(depth) * 14)
                    Image(systemName: node.isDirectory ? (state.isDirectoryExpanded(node.path) ? "chevron.down" : "chevron.right") : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(node.isDirectory ? Color.secondary : Color.clear)
                        .frame(width: 12, height: 18)
                    Image(systemName: iconName)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(iconColor)
                        .frame(width: 15)
                    Text(node.name)
                        .font(.system(size: 12.5, weight: hasProviderProvenance ? .semibold : .regular))
                        .foregroundStyle(hasProviderProvenance ? Color.green : Color.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if hasProviderProvenance {
                        Circle()
                            .fill(Color.green)
                            .frame(width: 5, height: 5)
                            .help("Contains lines linked to \(node.file?.provenanceProviders.joined(separator: ", ") ?? "AI provider") provenance")
                    }
                    Spacer(minLength: 4)
                }
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .frame(minHeight: 24)
                .background(isSelected ? Color.accentColor.opacity(0.20) : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: 5))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if node.isDirectory && state.isDirectoryExpanded(node.path) {
                ForEach(node.children) { child in
                    FileTreeRow(node: child, depth: depth + 1)
                }
            }
        }
    }

    private var isSelected: Bool {
        state.selectedFile?.path == node.file?.path
    }

    private var hasProviderProvenance: Bool {
        guard !node.isDirectory else { return false }
        return !(node.file?.provenanceProviders.isEmpty ?? true)
    }

    private var iconName: String {
        if node.isDirectory {
            return state.isDirectoryExpanded(node.path) ? "folder.fill" : "folder"
        }
        if node.name.hasSuffix(".swift") { return "swift" }
        if node.name.hasSuffix(".md") { return "doc.richtext" }
        if node.name.hasSuffix(".json") || node.name.hasSuffix(".toml") { return "curlybraces" }
        return "doc.text"
    }

    private var iconColor: Color {
        if node.isDirectory { return .blue.opacity(0.85) }
        return hasProviderProvenance ? .green.opacity(0.85) : .secondary
    }
}

struct ProvenanceSummaryView: View {
    var summary: ProvenanceSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("AI provenance")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            SummaryRow(value: summary.providers.isEmpty ? "None" : summary.providers.joined(separator: ", "), label: "providers")
            SummaryRow(value: "\(summary.sessionsCaptured)", label: "sessions captured")
            SummaryRow(value: "\(summary.toolCalls)", label: "tool calls")
            SummaryRow(value: "\(summary.filesEdited)", label: "files edited")
            SummaryRow(value: "\(summary.explainedPercent)%", label: "of demo lines explained")
            if let provider = summary.providers.first {
                HStack {
                    Pill("Captured from \(provider)", color: .green)
                    Pill("Git mapped", color: .blue)
                }
            } else {
                HStack {
                    Pill("No provider events yet", color: .orange)
                    Pill("Git mapped", color: .blue)
                }
            }
            Pill("Inferred only", color: .orange)
        }
        .padding(12)
        .background(Color.panel)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.08)))
    }
}

struct CaptureStatusView: View {
    var summary: ProvenanceSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Capture status")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text("Hook config: \(summary.configured ? "installed" : "missing")")
            Text("Capture activity: \(summary.eventsCaptured > 0 ? "seen" : "not seen yet")")
            Text("Events captured: \(summary.eventsCaptured)")
            Text("Last session: \(summary.lastSession)")
            Text("Last provider event: \(summary.lastEvent)")
            if summary.configured && summary.eventsCaptured == 0 {
                Text("Codex has trusted the hook config, but Lineage has not seen the collector write an event yet. Start a new Codex turn in this repo after installing capture.")
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

struct CodePaneView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.selectedFile?.name ?? "No file")
                        .font(.headline)
                    Text(state.selectedFile?.path ?? "")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(18)
            Divider().overlay(Color.white.opacity(0.08))

            ScrollViewReader { proxy in
                HStack(spacing: 0) {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(state.codeLines) { line in
                                CodeLineRow(line: line, selected: state.selectedLine == line)
                                    .id(line.id)
                                    .onTapGesture { state.select(line: line) }
                            }
                        }
                        .padding(.vertical, 12)
                    }
                    ProvenancePreviewRail(
                        markers: codeProvenanceMarkers,
                        selectedID: state.selectedLine.map { "\($0.id)" },
                        emptyHelp: "No provider-linked lines in this file"
                    ) { id in
                        guard let number = Int(id),
                              let line = state.codeLines.first(where: { $0.number == number }) else { return }
                        state.select(line: line)
                        withAnimation(.easeInOut(duration: 0.18)) {
                            proxy.scrollTo(line.id, anchor: .center)
                        }
                    }
                }
                .background(Color.codeBackground)
            }
        }
    }

    private var codeProvenanceMarkers: [ProvenancePreviewMarker] {
        let denominator = max(state.codeLines.count - 1, 1)
        return state.codeLines.enumerated().compactMap { offset, line in
            guard let badge = line.badge else { return nil }
            return ProvenancePreviewMarker(
                id: "\(line.number)",
                position: Double(offset) / Double(denominator),
                provider: badge,
                confidence: line.confidence
            )
        }
    }
}

struct ReviewDiffPaneView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.selectedReviewFile?.path ?? "No changed file selected")
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let snapshot = state.reviewSnapshot {
                        Text("\(snapshot.baseBranch) ... \(snapshot.headBranch)")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if state.isLoadingReview {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .padding(18)
            Divider().overlay(Color.white.opacity(0.08))

            if let fileDiff = state.selectedFileDiff {
                ScrollViewReader { proxy in
                    HStack(spacing: 0) {
                        ScrollView {
                            LazyVStack(spacing: 0) {
                                ForEach(fileDiff.hunks) { hunk in
                                    DiffHunkHeader(text: hunk.header)
                                    ForEach(hunk.lines) { line in
                                        DiffLineRow(line: line, selected: state.selectedReviewDiffLine == line)
                                            .id(line.id)
                                            .onTapGesture { state.selectReviewLine(line) }
                                    }
                                }
                            }
                            .padding(.vertical, 12)
                        }
                        ProvenancePreviewRail(
                            markers: reviewProvenanceMarkers(fileDiff),
                            selectedID: state.selectedReviewDiffLine?.id,
                            emptyHelp: "No provider-linked lines in this diff"
                        ) { id in
                            guard let line = fileDiff.lines.first(where: { $0.id == id }) else { return }
                            state.selectReviewLine(line)
                            withAnimation(.easeInOut(duration: 0.18)) {
                                proxy.scrollTo(line.id, anchor: .center)
                            }
                        }
                    }
                    .background(Color.codeBackground)
                }
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "doc.text.magnifyingglass")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text("Select a changed file to review its hunks.")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.codeBackground)
            }
        }
    }

    private func reviewProvenanceMarkers(_ fileDiff: FileDiff) -> [ProvenancePreviewMarker] {
        let lines = fileDiff.lines
        let denominator = max(lines.count - 1, 1)
        return lines.enumerated().compactMap { offset, line in
            guard let badge = line.badge else { return nil }
            return ProvenancePreviewMarker(
                id: line.id,
                position: Double(offset) / Double(denominator),
                provider: badge,
                confidence: line.confidence
            )
        }
    }
}

struct ProvenancePreviewMarker: Identifiable, Hashable {
    var id: String
    var position: Double
    var provider: String
    var confidence: Double?
}

struct ProvenancePreviewRail: View {
    var markers: [ProvenancePreviewMarker]
    var selectedID: String?
    var emptyHelp: String
    var onSelect: (String) -> Void

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .top) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color.white.opacity(0.045))
                    .frame(width: 10)
                    .frame(maxHeight: .infinity)
                    .position(x: geometry.size.width / 2, y: geometry.size.height / 2)
                    .help(markers.isEmpty ? emptyHelp : "Provider provenance preview")
                ForEach(markers) { marker in
                    Button {
                        onSelect(marker.id)
                    } label: {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(marker.id == selectedID ? Color.accentColor : Color.green)
                            .frame(width: marker.id == selectedID ? 12 : 8, height: marker.id == selectedID ? 8 : 5)
                            .shadow(color: Color.green.opacity(marker.id == selectedID ? 0.35 : 0), radius: 3)
                    }
                    .buttonStyle(.plain)
                    .position(
                        x: geometry.size.width / 2,
                        y: markerY(marker.position, height: geometry.size.height)
                    )
                    .help(helpText(for: marker))
                }
            }
        }
        .frame(width: 22)
        .padding(.vertical, 12)
        .padding(.trailing, 6)
    }

    private func markerY(_ position: Double, height: CGFloat) -> CGFloat {
        let clamped = min(max(position, 0), 1)
        let usableHeight = max(height - 8, 1)
        return 4 + CGFloat(clamped) * usableHeight
    }

    private func helpText(for marker: ProvenancePreviewMarker) -> String {
        if let confidence = marker.confidence {
            return "\(marker.provider) provenance, \(Int(confidence * 100))% match"
        }
        return "\(marker.provider) provenance"
    }
}

struct DiffHunkHeader: View {
    var text: String

    var body: some View {
        HStack {
            Text(text)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.cyan)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(Color.cyan.opacity(0.08))
    }
}

struct DiffLineRow: View {
    var line: DiffLine
    var selected: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(line.oldLine.map(String.init) ?? "")
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.tertiary)
                .frame(width: 38, alignment: .trailing)
            Text(line.newLine.map(String.init) ?? "")
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.tertiary)
                .frame(width: 38, alignment: .trailing)
            Text(prefix)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(prefixColor)
                .frame(width: 12)
            Text(line.commitSHA ?? "-------")
                .font(.caption.monospaced())
                .foregroundStyle(line.commitSHA == nil ? Color.secondary.opacity(0.35) : commitColor)
                .frame(width: 58, alignment: .leading)
                .help(line.commitSummary ?? "No Git commit identity available for this diff line")
            Text(line.text.isEmpty ? " " : line.text)
                .font(.system(size: 13, design: .monospaced))
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let badge = line.badge {
                Text(badge)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(Color.green.opacity(0.16))
                    .foregroundStyle(Color.green)
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                    .help("AI provider provenance for this diff line")
                if let confidence = line.confidence {
                    Text("\(Int(confidence * 100))%")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .help("Provenance match confidence")
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 2)
        .background(selected ? Color.accentColor.opacity(0.22) : background)
        .contentShape(Rectangle())
    }

    private var prefix: String {
        switch line.kind {
        case "addition": return "+"
        case "deletion": return "-"
        default: return " "
        }
    }

    private var prefixColor: Color {
        switch line.kind {
        case "addition": return .green
        case "deletion": return .red
        default: return .secondary
        }
    }

    private var background: Color {
        switch line.kind {
        case "addition": return Color.green.opacity(0.10)
        case "deletion": return Color.red.opacity(0.10)
        default: return Color.clear
        }
    }

    private var commitColor: Color {
        switch line.kind {
        case "addition": return .green
        case "deletion": return .red
        default: return .secondary
        }
    }
}

struct CodeLineRow: View {
    var line: CodeLine
    var selected: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(line.number)")
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.tertiary)
                .frame(width: 42, alignment: .trailing)
            Text(line.text.isEmpty ? " " : line.text)
                .font(.system(size: 13, design: .monospaced))
                .foregroundStyle(color(for: line.text))
                .frame(maxWidth: .infinity, alignment: .leading)
            if let commitSHA = line.commitSHA {
                Text(commitSHA)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(Color.white.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                    .help(line.commitSummary ?? "Git commit for this line")
            }
            if let badge = line.badge {
                Text(badge)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(Color.green.opacity(0.16))
                    .foregroundStyle(Color.green)
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                if let confidence = line.confidence {
                    Text("\(Int(confidence * 100))%")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
        .background(selected ? Color.accentColor.opacity(0.22) : Color.clear)
        .contentShape(Rectangle())
    }

    private func color(for text: String) -> Color {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("def ") || trimmed.hasPrefix("class ") { return .cyan }
        if trimmed.hasPrefix("if ") || trimmed.hasPrefix("return") || trimmed.hasPrefix("raise") { return .purple.opacity(0.9) }
        if trimmed.contains("\"") { return .green.opacity(0.9) }
        return .primary
    }
}

struct ReviewExplanationPaneView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text(state.selectedReviewDiffLine == nil ? "Why did this change happen?" : "Why does this line exist?")
                        .font(.title2.weight(.semibold))
                    Spacer()
                    Button(action: state.loadReviewSnapshot) {
                        Image(systemName: "arrow.clockwise")
                    }
                    .help("Refresh branch review")
                }

                if let snapshot = state.reviewSnapshot {
                    SectionBlock("Review scope") {
                        Detail("Base", snapshot.baseBranch)
                        Detail("Head", snapshot.headBranch)
                        Detail("Merge base", snapshot.mergeBase.isEmpty ? "Unknown" : snapshot.mergeBase)
                        Text("Local branch review approximates MR review from Git state. No remote PR/MR metadata is used yet.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if state.isExplainingReviewLine {
                    HStack(spacing: 10) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Gathering line provenance and Git evidence...")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 20)
                } else if let explanation = state.reviewLineExplanation, let line = state.selectedReviewDiffLine {
                    SectionBlock("Selected diff line") {
                        Detail("File", explanation.selectedFile)
                        Detail("Line", "\(explanation.selectedLine)")
                        Detail("Side", line.kind == "deletion" ? "Base / removed line" : "Head / current line")
                        Detail("Code", explanation.selectedCode)
                        Detail("Branch", line.kind == "deletion" ? state.reviewBaseBranch : (state.repository?.branch ?? "Unknown"))
                        Detail("Git commit", [explanation.gitEvidence.commitSHA, explanation.gitEvidence.summary].filter { !$0.isEmpty && $0 != "Unknown" }.joined(separator: " - "))
                    }
                    SourceBadge(providerName: explanation.providerSession?.providerDisplayName)
                    SectionBlock("Answer") {
                        Text(explanation.answer)
                            .font(.body.weight(.medium))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ProviderProvenanceView(session: explanation.providerSession)
                    DecisionProvenanceView(provenance: explanation.decisionProvenance)
                    if let architectureDecision = explanation.architectureDecision {
                        ArchitectureDecisionView(decision: architectureDecision)
                    }
                    ConfidenceView(explanation: explanation)
                    TimelineView(items: explanation.timeline)
                    GitEvidenceView(evidence: explanation.gitEvidence)
                    EvidenceView(cards: explanation.evidence)
                } else if state.isLoadingReview && state.reviewExplanation == nil {
                    HStack(spacing: 10) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Gathering change evidence...")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 20)
                } else if let explanation = state.reviewExplanation {
                    SourceBadge(providerName: explanation.providerSessions.first?.providerDisplayName)
                    SectionBlock("Answer") {
                        Text(explanation.answer)
                            .font(.body.weight(.medium))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    SectionBlock("Confidence") {
                        HStack {
                            Pill(explanation.confidenceLabel, color: explanation.providerSessions.isEmpty ? .orange : .green)
                            Pill(explanation.gitSummary, color: .blue)
                        }
                    }
                    if !explanation.providerSessions.isEmpty {
                        SectionBlock("Linked provider sessions") {
                            ForEach(explanation.providerSessions) { session in
                                LinkedSessionRow(session: session)
                            }
                        }
                    }
                    EvidenceView(cards: explanation.evidence)
                } else {
                    Text("Select a changed file to inspect why it changed.")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(22)
        }
        .background(Color.panel.opacity(0.55))
    }
}

struct ExplanationPaneView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("Why does this line exist?")
                        .font(.title2.weight(.semibold))
                    Spacer()
                    Button(action: state.refreshRepository) {
                        Image(systemName: "arrow.clockwise")
                    }
                    .help("Refresh Git and Lineage provenance")
                    Button(action: state.exportExplanation) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .help("Export Explanation")
                    .disabled(state.explanation == nil)
                }
                if state.isExplaining {
                    HStack(spacing: 10) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Gathering AI provenance and Git evidence...")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 20)
                } else if let explanation = state.explanation {
                    SectionBlock("Selected line") {
                        Detail("File", explanation.selectedFile)
                        Detail("Line", "\(explanation.selectedLine)")
                        Detail("Code", explanation.selectedCode)
                        Detail("Branch", state.repository?.branch ?? "Unknown")
                        Detail("Git commit", [explanation.gitEvidence.commitSHA, explanation.gitEvidence.summary].filter { !$0.isEmpty && $0 != "Unknown" }.joined(separator: " - "))
                    }
                    SourceBadge(providerName: explanation.providerSession?.providerDisplayName)
                    SectionBlock("Answer") {
                        Text(explanation.answer)
                            .font(.body.weight(.medium))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ProviderProvenanceView(session: explanation.providerSession)
                    DecisionProvenanceView(provenance: explanation.decisionProvenance)
                    if let architectureDecision = explanation.architectureDecision {
                        ArchitectureDecisionView(decision: architectureDecision)
                    }
                    ConfidenceView(explanation: explanation)
                    TimelineView(items: explanation.timeline)
                    GitEvidenceView(evidence: explanation.gitEvidence)
                    EvidenceView(cards: explanation.evidence)
                    RemovalView(assessment: explanation.couldRemove)
                    FollowUpView(explanation: explanation)
                } else {
                    Text("Select a line to inspect its provenance.")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(22)
        }
        .background(Color.panel.opacity(0.55))
    }
}

struct ProviderProvenanceView: View {
    var session: ProvenanceSession?

    var body: some View {
        SectionBlock("Session evidence") {
            if let session {
                SessionEvidenceView(session: session)
            } else {
                Text("No AI provider provenance found - inferred from Git history")
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct LinkedSessionRow: View {
    @EnvironmentObject private var state: AppState
    var session: ProvenanceSession

    var body: some View {
        Button {
            state.showSessionPivot(session)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(session.sessionID)
                        .font(.callout.weight(.semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Image(systemName: "rectangle.stack")
                        .foregroundStyle(.secondary)
                }
                Text(session.prompt.isEmpty ? "No prompt captured." : session.prompt)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                HStack {
                    Pill("\(session.lineRanges.count) ranges", color: .green)
                    Pill("\(session.filesEdited.count) files", color: .blue)
                    Pill(session.testsResult, color: session.testsResult == "passed" ? .green : .orange)
                }
            }
            .padding(10)
            .background(Color.black.opacity(0.16))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Open full session evidence and touched code")
    }
}

struct SessionDetailPivotView: View {
    @EnvironmentObject private var state: AppState
    var session: ProvenanceSession

    private var graphCodeNodes: [ProvenanceNode] {
        state.provenanceGraph?.linkedCodeNodes(sessionID: session.sessionID) ?? []
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Session Evidence")
                        .font(.title2.weight(.semibold))
                    Text("\(session.providerDisplayName) / \(session.sessionID)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                Button(action: state.exportAgentTrace) {
                    Label("Agent Trace", systemImage: "point.3.connected.trianglepath.dotted")
                }
                .buttonStyle(.bordered)
                Button("Done") {
                    state.selectedSessionPivot = nil
                }
                .keyboardShortcut(.cancelAction)
            }
            .padding(18)
            Divider().overlay(Color.white.opacity(0.08))

            HSplitView {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        SectionBlock("Code touched") {
                            SessionTouchedRangesView(ranges: session.lineRanges)
                            if !graphCodeNodes.isEmpty {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("Graph nodes")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                    ForEach(graphCodeNodes.prefix(80)) { node in
                                        HStack {
                                            Text(node.kind.rawValue)
                                                .font(.caption2.monospaced())
                                                .foregroundStyle(.tertiary)
                                                .frame(width: 72, alignment: .leading)
                                            Text(node.label)
                                                .font(.caption)
                                                .lineLimit(1)
                                                .truncationMode(.middle)
                                            Spacer()
                                        }
                                        .padding(7)
                                        .background(Color.black.opacity(0.14))
                                        .clipShape(RoundedRectangle(cornerRadius: 7))
                                    }
                                }
                            }
                        }
                    }
                    .padding(18)
                }
                .frame(minWidth: 260, idealWidth: 320)

                ScrollView {
                    SessionEvidenceView(session: session)
                        .environmentObject(state)
                        .padding(18)
                }
                .frame(minWidth: 420)
            }
        }
        .background(Color.lineageBackground)
    }
}

struct SessionEvidenceView: View {
    @EnvironmentObject private var state: AppState
    var session: ProvenanceSession
    @State private var bundle: SessionEvidenceBundle?
    @State private var showAllTools = false
    @State private var showAllCommands = false
    @State private var transcriptExpanded = false
    @State private var showFullTranscript = false

    var body: some View {
        let evidence = bundle ?? SessionEvidenceLoader().load(session: session)
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(evidence.provider)
                        .font(.callout.weight(.semibold))
                    Text(evidence.source == "codex-transcript-recovery" ? "Recovered from Codex transcript" : "Captured from provider events")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    state.exportAgentTrace()
                } label: {
                    Image(systemName: "point.3.connected.trianglepath.dotted")
                }
                .help("Export Agent Trace JSONL")
                Button {
                    state.showSessionPivot(session)
                } label: {
                    Image(systemName: "rectangle.stack")
                }
                .help("Open full session evidence")
                Button {
                    exportMarkdown(evidence)
                } label: {
                    Image(systemName: "doc.text")
                }
                .help("Export session evidence as Markdown")
                Button {
                    exportJSON(evidence)
                } label: {
                    Image(systemName: "curlybraces")
                }
                .help("Export session evidence as JSON")
            }

            Detail("Provider session", evidence.sessionID)
            Detail("Model", evidence.model ?? "Unknown")
            Detail("Permission mode", evidence.permissionMode ?? "Unknown")
            Detail("Transcript path", evidence.transcriptPath ?? "Unavailable")
            Detail("Linked commit", [evidence.commitSHA, evidence.commitMessage].compactMap { $0 }.joined(separator: " - "))

            SessionHierarchySummary(evidence: evidence)
            SessionTouchedRangesView(ranges: evidence.lineRanges)
            SessionEventTimelineView(events: evidence.timeline)

            DisclosureGroup("Prompt") {
                EvidenceText(evidence.prompt.isEmpty ? "No prompt captured." : evidence.prompt)
            }

            DisclosureGroup("Final assistant message") {
                EvidenceText(evidence.finalMessage.isEmpty ? "No final provider message captured." : evidence.finalMessage)
            }

            LimitedEvidenceList(title: "Tools used", values: evidence.toolsUsed, showAll: $showAllTools)
            LimitedEvidenceList(title: "Commands run", values: evidence.commandsRun, showAll: $showAllCommands, monospace: true)

            DisclosureGroup("Files, tests, and permissions") {
                Detail("Files edited", evidence.filesEdited.joined(separator: "\n"))
                Detail("Tests run", evidence.testsRun.joined(separator: "\n"))
                Detail("Test result", evidence.testsResult)
                Detail("Approval / permission events", evidence.permissionRequests.joined(separator: "\n"))
            }

            SessionTranscriptPanel(
                evidence: evidence,
                isExpanded: $transcriptExpanded,
                showFullTranscript: $showFullTranscript
            )

            DisclosureGroup("Git diff") {
                EvidenceText(evidence.gitDiff.isEmpty ? "No diff captured for this session." : evidence.gitDiff, monospace: true)
            }

            Text("Lineage shows captured provider transcript/events and Git evidence only. It does not capture or display private model reasoning.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .onAppear {
            bundle = SessionEvidenceLoader().load(session: session)
        }
    }

    private func exportMarkdown(_ evidence: SessionEvidenceBundle) {
        guard let url = saveURL(defaultName: "Lineage Session \(session.sessionID).md") else { return }
        try? SessionEvidenceExporter.markdown(bundle: evidence).write(to: url, atomically: true, encoding: .utf8)
    }

    private func exportJSON(_ evidence: SessionEvidenceBundle) {
        guard let url = saveURL(defaultName: "Lineage Session \(session.sessionID).json") else { return }
        if let data = try? SessionEvidenceExporter.jsonData(bundle: evidence) {
            try? data.write(to: url, options: [.atomic])
        }
    }

    private func saveURL(defaultName: String) -> URL? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = defaultName
        panel.canCreateDirectories = true
        return panel.runModal() == .OK ? panel.url : nil
    }
}

struct SessionTouchedRangesView: View {
    var ranges: [LineRange]

    private var groupedRanges: [(String, [LineRange])] {
        Dictionary(grouping: ranges, by: \.file)
            .map { entry in
                (entry.key, entry.value.sorted { lhs, rhs in
                    lhs.start == rhs.start ? lhs.end < rhs.end : lhs.start < rhs.start
                })
            }
            .sorted { $0.0.localizedStandardCompare($1.0) == .orderedAscending }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Files and ranges touched")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if groupedRanges.isEmpty {
                Text("No line ranges were linked for this session.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(groupedRanges, id: \.0) { file, fileRanges in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(file)
                            .font(.caption.monospaced().weight(.semibold))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 6)], alignment: .leading, spacing: 6) {
                            ForEach(fileRanges) { range in
                                Text("\(range.start)-\(range.end)")
                                    .font(.caption2.monospacedDigit().weight(.semibold))
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 4)
                                    .background(Color.green.opacity(0.14))
                                    .foregroundStyle(Color.green)
                                    .clipShape(RoundedRectangle(cornerRadius: 5))
                                    .help("\(Int(range.confidence * 100))% \(range.label)")
                            }
                        }
                    }
                    .padding(8)
                    .background(Color.black.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
    }
}

struct SessionEventTimelineView: View {
    var events: [SessionTimelineEvent]

    private var groupedEvents: [(String, [SessionTimelineEvent])] {
        let order = ["Prompt", "Tool", "Decision", "Constraint", "Test", "Final response"]
        let grouped = Dictionary(grouping: events) { $0.group }
        return order.compactMap { group in
            guard let values = grouped[group], !values.isEmpty else { return nil }
            return (group, values)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Event timeline")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if groupedEvents.isEmpty {
                Text("No prompt, tool, decision, test, or final-response events were summarized for this session.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(groupedEvents, id: \.0) { group, values in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 7) {
                                Circle()
                                    .fill(color(for: group))
                                    .frame(width: 7, height: 7)
                                Text(group)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.primary)
                                Spacer()
                                Text("\(values.count)")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(.tertiary)
                            }
                            ForEach(values) { event in
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(event.title)
                                        .font(.caption.weight(.semibold))
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                    Text(event.detail.isEmpty ? "No details captured." : event.detail)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(4)
                                        .textSelection(.enabled)
                                }
                                .padding(8)
                                .background(Color.black.opacity(0.14))
                                .clipShape(RoundedRectangle(cornerRadius: 7))
                            }
                        }
                    }
                }
            }
        }
    }

    private func color(for group: String) -> Color {
        switch group {
        case "Prompt": return .cyan
        case "Tool": return .blue
        case "Decision": return .green
        case "Constraint": return .orange
        case "Test": return .purple
        default: return .secondary
        }
    }
}

struct SessionHierarchySummary: View {
    var evidence: SessionEvidenceBundle

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Session hierarchy")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 7) {
                SessionHierarchyRow(icon: "text.alignleft", title: "Selected line or changed file", detail: "Matched to provider evidence")
                SessionHierarchyRow(icon: "bubble.left.and.bubble.right", title: "\(evidence.provider) session", detail: shortSessionID)
                SessionHierarchyRow(icon: "archivebox", title: "Evidence set", detail: "\(evidence.messages.count) transcript events, \(evidence.toolsUsed.count) tools, \(evidence.filesEdited.count) files")
            }
            .padding(8)
            .background(Color.black.opacity(0.14))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private var shortSessionID: String {
        if evidence.sessionID.count > 18 {
            return "\(evidence.sessionID.prefix(18))..."
        }
        return evidence.sessionID
    }
}

struct SessionHierarchyRow: View {
    var icon: String
    var title: String
    var detail: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(.green)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
    }
}

struct SessionTranscriptPanel: View {
    var evidence: SessionEvidenceBundle
    @Binding var isExpanded: Bool
    @Binding var showFullTranscript: Bool

    private var visibleMessages: [SessionTranscriptMessage] {
        showFullTranscript ? evidence.messages : Array(evidence.messages.prefix(12))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Session transcript")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(transcriptSummary)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                Button {
                    withAnimation(.easeInOut(duration: 0.16)) {
                        isExpanded.toggle()
                    }
                } label: {
                    Label(isExpanded ? "Collapse" : "Open", systemImage: isExpanded ? "chevron.up" : "chevron.down")
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help(isExpanded ? "Collapse session transcript" : "Open captured session transcript")
            }
            .padding(8)
            .background(Color.black.opacity(0.18))
            .clipShape(RoundedRectangle(cornerRadius: 8))

            if isExpanded {
                transcriptBody
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    @ViewBuilder
    private var transcriptBody: some View {
        if evidence.transcriptAvailable {
            if evidence.messages.isEmpty {
                Text("Transcript file was found, but no displayable provider messages or tool events were parsed.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                VStack(spacing: 8) {
                    ForEach(Array(visibleMessages.enumerated()), id: \.element.id) { index, message in
                        if index > 0 && index % 8 == 0 {
                            TranscriptCollapseBar(
                                shownCount: index,
                                totalCount: evidence.messages.count,
                                collapse: collapseTranscript
                            )
                        }
                        TranscriptBubble(message: message)
                    }
                    if evidence.messages.count > visibleMessages.count {
                        Button("Show all \(evidence.messages.count) transcript events") {
                            showFullTranscript = true
                        }
                        .buttonStyle(.link)
                    }
                    if evidence.messages.count > 8 {
                        TranscriptCollapseBar(
                            shownCount: visibleMessages.count,
                            totalCount: evidence.messages.count,
                            collapse: collapseTranscript
                        )
                    }
                }
            }
        } else {
            Text("Transcript unavailable locally. Lineage has the stored path, but the file could not be read on this machine.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private var transcriptSummary: String {
        if !evidence.transcriptAvailable { return "Unavailable locally" }
        if evidence.messages.isEmpty { return "No displayable messages parsed" }
        let tools = evidence.messages.filter { $0.role == "tool" }.count
        return "\(evidence.messages.count) events, \(tools) tool events"
    }

    private func collapseTranscript() {
        withAnimation(.easeInOut(duration: 0.16)) {
            isExpanded = false
            showFullTranscript = false
        }
    }
}

struct TranscriptCollapseBar: View {
    var shownCount: Int
    var totalCount: Int
    var collapse: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Rectangle()
                .fill(Color.white.opacity(0.10))
                .frame(height: 1)
            Text("\(shownCount)/\(totalCount)")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
            Button("Collapse transcript", action: collapse)
                .buttonStyle(.link)
                .font(.caption)
            Rectangle()
                .fill(Color.white.opacity(0.10))
                .frame(height: 1)
        }
        .padding(.vertical, 2)
    }
}

struct LimitedEvidenceList: View {
    var title: String
    var values: [String]
    @Binding var showAll: Bool
    var monospace = false

    var body: some View {
        DisclosureGroup(title) {
            let visible = showAll ? values : Array(values.prefix(5))
            if visible.isEmpty {
                Text("None captured.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(visible.enumerated()), id: \.offset) { _, value in
                        EvidenceText(value, monospace: monospace)
                    }
                    if values.count > 5 {
                        Button(showAll ? "Show fewer" : "Show all \(values.count)") {
                            showAll.toggle()
                        }
                        .buttonStyle(.link)
                    }
                }
            }
        }
    }
}

struct EvidenceText: View {
    var text: String
    var monospace = false

    init(_ text: String, monospace: Bool = false) {
        self.text = text
        self.monospace = monospace
    }

    var body: some View {
        Text(text)
            .font(monospace ? .caption.monospaced() : .callout)
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
            .background(Color.black.opacity(0.14))
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct TranscriptBubble: View {
    var message: SessionTranscriptMessage
    @State private var expanded = false

    var body: some View {
        HStack {
            if message.role == "assistant" { Spacer(minLength: 28) }
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(message.title)
                        .font(.caption.weight(.semibold))
                    if let timestamp = message.timestamp {
                        Text(timestamp)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Text(displayBody)
                    .font(message.role == "tool" ? .caption.monospaced() : .callout)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if isLong {
                    Button(expanded ? "Show fewer" : "Show all \(lineCount) lines") {
                        expanded.toggle()
                    }
                    .buttonStyle(.link)
                    .font(.caption)
                }
            }
            .padding(10)
            .background(background)
            .foregroundStyle(foreground)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .frame(maxWidth: 340, alignment: alignment)
            if message.role == "user" || message.role == "tool" || message.role == "permission" { Spacer(minLength: 28) }
        }
    }

    private var alignment: Alignment {
        message.role == "assistant" ? .trailing : .leading
    }

    private var foreground: Color {
        message.role == "assistant" ? .white : .primary
    }

    private var background: Color {
        switch message.role {
        case "user":
            return Color.blue.opacity(0.20)
        case "assistant":
            return Color.accentColor.opacity(0.78)
        case "permission":
            return Color.orange.opacity(0.22)
        default:
            return Color.white.opacity(0.08)
        }
    }

    private var bodyText: String {
        message.body.isEmpty ? "No content captured." : message.body
    }

    private var lines: [Substring] {
        bodyText.split(separator: "\n", omittingEmptySubsequences: false)
    }

    private var lineCount: Int {
        lines.count
    }

    private var isLong: Bool {
        lineCount > 5
    }

    private var displayBody: String {
        guard isLong, !expanded else { return bodyText }
        return lines.prefix(5).joined(separator: "\n")
    }
}

struct DecisionProvenanceView: View {
    var provenance: DecisionProvenance

    var body: some View {
        SectionBlock("Decision provenance") {
            HStack {
                Pill(provenance.label, color: provenance.label == "Permission requested" ? .orange : .green)
                Spacer()
            }
            Text(provenance.detail)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Detail("Evidence", provenance.evidence.joined(separator: ", "))
        }
    }
}

struct ArchitectureDecisionView: View {
    var decision: ArchitectureDecision

    var body: some View {
        SectionBlock("Decision record") {
            Detail("Context", decision.context)
            Detail("Decision", decision.decision)
            if !decision.alternatives.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Alternatives considered")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    ForEach(decision.alternatives) { option in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(option.text)
                                .font(.callout)
                            if let rationale = option.rationale {
                                Text(rationale)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(8)
                        .background(Color.black.opacity(0.16))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
            Detail("Evidence", decision.evidence.joined(separator: ", "))
            Detail("Consequences / risk", decision.consequences)
        }
    }
}

struct ConfidenceView: View {
    var explanation: LineExplanation

    var body: some View {
        SectionBlock("Confidence") {
            HStack {
                Text("\(Int(explanation.confidence * 100))%")
                    .font(.title3.monospacedDigit().weight(.semibold))
                Text(explanation.confidenceLabel)
                    .foregroundStyle(.secondary)
            }
            HStack {
                if let session = explanation.providerSession {
                    Pill("Recorded \(session.providerDisplayName) provenance", color: .green)
                } else {
                    Pill("No provider provenance", color: .orange)
                }
                Pill("Linked Git commit", color: .blue)
            }
            HStack {
                Pill("Git blame", color: .cyan)
                Pill(explanation.providerSession == nil ? "Weak evidence" : "Provider final message", color: explanation.providerSession == nil ? .orange : .green)
            }
        }
    }
}

struct GitEvidenceView: View {
    var evidence: GitLineEvidence

    var body: some View {
        SectionBlock("Git evidence") {
            Detail("Commit", evidence.commitSHA)
            Detail("Summary", evidence.summary)
            Detail("Author", "\(evidence.authorName) \(evidence.authorEmail)")
            Detail("Authored", evidence.authorDate)
            Detail("Committer", "\(evidence.committerName) \(evidence.committerEmail)")
            Detail("Committed", evidence.committerDate)
            Text("Git records who authored and committed the change. AI provider provenance records the prompt, tools, permission events, and session evidence behind it.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct TimelineView: View {
    var items: [String]

    var body: some View {
        SectionBlock("Farm-to-fork trace") {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .top, spacing: 10) {
                        VStack(spacing: 0) {
                            Circle().fill(Color.accentColor).frame(width: 8, height: 8)
                            if index < items.count - 1 {
                                Rectangle().fill(Color.white.opacity(0.14)).frame(width: 1, height: 24)
                            }
                        }
                        Text(item)
                            .font(.callout)
                            .padding(.bottom, index < items.count - 1 ? 14 : 0)
                    }
                }
            }
        }
    }
}

struct EvidenceView: View {
    var cards: [EvidenceCard]

    var body: some View {
        SectionBlock("Evidence") {
            ForEach(cards) { card in
                DisclosureGroup {
                    Text(card.body)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 6)
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(card.title)
                            .font(.callout.weight(.semibold))
                        Text(card.kind)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(10)
                .background(Color.black.opacity(0.18))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}

struct RemovalView: View {
    var assessment: RemovalAssessment

    var body: some View {
        SectionBlock("Could we remove this?") {
            Detail("Risk", assessment.risk)
            Detail("References count", "\(assessment.referencesCount)")
            Detail("Test coverage", assessment.testCoverage)
            Text(assessment.assessment)
                .fixedSize(horizontal: false, vertical: true)
            Detail("Recommended next step", assessment.recommendedNextStep)
        }
    }
}

struct FollowUpView: View {
    @EnvironmentObject private var state: AppState
    var explanation: LineExplanation

    var body: some View {
        SectionBlock("Ask follow-up") {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(explanation.followUpQuestions, id: \.self) { question in
                    Button(question) { state.askFollowUp(question) }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                }
                HStack {
                    TextField("Ask about this line's evidence", text: $state.followUpQuestion)
                        .textFieldStyle(.plain)
                    Button("Ask") { state.askFollowUp() }
                }
                .padding(10)
                .background(Color.black.opacity(0.22))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                if let answer = state.followUpAnswer {
                    Text(answer)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

struct SectionBlock<Content: View>: View {
    var title: String
    @ViewBuilder var content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct Detail: View {
    var label: String
    var value: String

    init(_ label: String, _ value: String) {
        self.label = label
        self.value = value.isEmpty ? "None" : value
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }
}

struct SummaryRow: View {
    var value: String
    var label: String

    var body: some View {
        HStack {
            Text(value)
                .font(.callout.monospacedDigit().weight(.semibold))
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
    }
}

struct Pill: View {
    var text: String
    var color: Color

    init(_ text: String, color: Color) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(color.opacity(0.16))
            .foregroundStyle(color)
            .clipShape(RoundedRectangle(cornerRadius: 5))
    }
}

struct SourceBadge: View {
    var providerName: String?

    var body: some View {
        let recorded = providerName != nil
        HStack {
            Circle()
                .fill(recorded ? Color.green : Color.orange)
                .frame(width: 8, height: 8)
            Text(recorded ? "Source of truth: Captured from \(providerName ?? "AI provider")" : "No AI provider provenance found - inferred from Git history")
                .font(.callout.weight(.semibold))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background((recorded ? Color.green : Color.orange).opacity(0.13))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct LoadingOverlay: View {
    var message: String

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.large)
            Text(message)
                .font(.callout.weight(.semibold))
            Text("Lineage is reading Git and provenance data in the background.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(22)
        .background(Color.panel)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.10)))
        .shadow(color: .black.opacity(0.35), radius: 24, y: 12)
    }
}

struct SearchField: View {
    @Binding var text: String

    var body: some View {
        HStack {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Search files", text: $text)
                .textFieldStyle(.plain)
        }
        .padding(9)
        .background(Color.black.opacity(0.22))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Color.white.opacity(configuration.isPressed ? 0.82 : 0.96))
            .foregroundStyle(Color.black)
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Color.white.opacity(configuration.isPressed ? 0.10 : 0.07))
            .foregroundStyle(.primary)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.10)))
    }
}

struct IconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.semibold))
            .frame(width: 32, height: 32)
            .background(Color.white.opacity(configuration.isPressed ? 0.12 : 0.07))
            .foregroundStyle(.primary)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.10)))
    }
}

extension Color {
    static let lineageBackground = Color(red: 0.055, green: 0.058, blue: 0.064)
    static let panel = Color(red: 0.085, green: 0.09, blue: 0.10)
    static let codeBackground = Color(red: 0.045, green: 0.048, blue: 0.055)
}
