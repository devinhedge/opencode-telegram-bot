# opencode-telegram-bot：Windows 11 / macOS Apple Silicon 相容性調研

- 日期時間：2026-10-10 14:37（Asia/Taipei）
- Repository：liuxb99/opencode-telegram-bot
- 基準分支：main
- 狀態：跨平台調研啟動；未修改執行程式，未完成實機驗證。

## 目的
保留現有 Windows 11 功能，評估加入 Mac Studio（Apple Silicon arm64）執行、測試、展示或遠端工作的可行性。不得把「新增研究文件」誤判為「已支援 macOS」。

## 必須盤點
1. 啟動/部署：PowerShell、cmd/bat、schtasks、Windows Service、登錄檔與 Windows 專用 API；評估 launchd、zsh/pwsh7。
2. 路徑/權限：磁碟代號、反斜線、大小寫、symlink、POSIX、TCC、Keychain。
3. 依賴：Python wheels、Node native modules、Go CGO、可執行檔與 darwin-arm64 支援。
4. GPU：CUDA 與 Metal/MPS 能力分離；無 macOS 等價功能時標記 Windows-only。
5. 整合：DirectWork、RDC、Google Drive、GitHub、Supabase、輸出格式及網路服務。
6. 自動更新：macOS 安裝、健康檢查、日誌、回滾與版本相容性。

## 分階段驗收
- P0：逐檔原始碼掃描，產出 Windows-only / cross-platform / macOS-only 清單。
- P1：最小 OS adapter，避免影響既有 Windows 路徑。
- P2：Mac Studio arm64 環境安裝與 smoke test。
- P3：實際功能、輸出一致性與 regression 測試。
- P4：自動部署、升級、回滾與長時間穩定性測試。

## 原則與限制
- 此文檔是專案調研起點，並非逐檔掃描結果；不宣稱已在 macOS 運作。
- macOS 不必取代 Windows 專屬 CAD/COM/CUDA 等能力；應保留跨節點派工。
- 每次更新記錄日期時間、commit、測試命令、結果及證據。
- DirectWork 統一架構參考：https://github.com/liuxb99/DirectWork/blob/master/docs/research/DIRECTWORK_MACOS_APPLE_SILICON_CROSS_PLATFORM_RESEARCH_2026-10-10.zh-TW.md
