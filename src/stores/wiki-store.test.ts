import { describe, expect, it } from "vitest"
import { useWikiStore } from "./wiki-store"

describe("backupConfig store action", () => {
  it("setBackupConfig updates enabled and remoteUrl", () => {
    useWikiStore.getState().setBackupConfig({ enabled: true, remoteUrl: "https://github.com/iFralex/llm-wiki-vault-backup.git" })
    expect(useWikiStore.getState().backupConfig.enabled).toBe(true)
    expect(useWikiStore.getState().backupConfig.remoteUrl).toContain("vault-backup")
  })
})

describe("backgroundMode store action", () => {
  it("setBackgroundMode updates the flag", () => {
    useWikiStore.getState().setBackgroundMode(true)
    expect(useWikiStore.getState().backgroundMode).toBe(true)
    useWikiStore.getState().setBackgroundMode(false)
    expect(useWikiStore.getState().backgroundMode).toBe(false)
  })
})

describe("wiki preview store actions", () => {
  it("opens a path in the wiki preview and clears external previews", () => {
    useWikiStore.setState({
      activeView: "chat",
      selectedFile: null,
      fileContent: "old",
      previewContentPath: "/old.md",
      externalPreview: {
        title: "External",
        path: "remote",
        source: "AnyTXT",
        url: "anytxt://remote",
        snippet: "snippet",
      },
    })

    useWikiStore.getState().openPathInPreview("/project/wiki/page.md")

    const state = useWikiStore.getState()
    expect(state.activeView).toBe("wiki")
    expect(state.selectedFile).toBe("/project/wiki/page.md")
    expect(state.fileContent).toBe("old")
    expect(state.previewContentPath).toBeNull()
    expect(state.externalPreview).toBeNull()
  })

  it("opens loaded file content in the wiki preview", () => {
    useWikiStore.setState({
      activeView: "search",
      selectedFile: null,
      fileContent: "",
      previewContentPath: null,
      externalPreview: {
        title: "External",
        path: "remote",
        source: "AnyTXT",
        url: "anytxt://remote",
        snippet: "snippet",
      },
    })

    useWikiStore.getState().openFileInPreview("/project/wiki/page.md", "# Page")

    const state = useWikiStore.getState()
    expect(state.activeView).toBe("wiki")
    expect(state.selectedFile).toBe("/project/wiki/page.md")
    expect(state.fileContent).toBe("# Page")
    expect(state.previewContentPath).toBe("/project/wiki/page.md")
    expect(state.externalPreview).toBeNull()
  })
})
