# 開発基本原則 (Core Development Philosophy)

- **開発の基本方針**: プロジェクト開発の基本として、常に [DESIGN_PHILOSOPHY.md](file:///workspaces/FPGA-BoardlessBench/DESIGN_PHILOSOPHY.md) に定義されている開発理念、厳格な開発プロトコル、検証プロトコル、およびライセンス戦略に例外なく従うこと。
- **アーキテクチャ・マニフェストの遵守**: 各フォルダのソースコードを修正・追加する際は、それぞれのフォルダ（またはその親フォルダ）に配置されている `ARCHITECTURE_MANIFEST.md` の記述を必ず参照し、その設計方針や規約に厳格に従うこと。各フォルダに配置されているマニフェストファイルの一覧は以下の通り：
  - ルート: [ARCHITECTURE_MANIFEST.md](file:///workspaces/FPGA-BoardlessBench/ARCHITECTURE_MANIFEST.md)
  - テストシナリオ全体: [tests/scenarios/ARCHITECTURE_MANIFEST.md](file:///workspaces/FPGA-BoardlessBench/tests/scenarios/ARCHITECTURE_MANIFEST.md)
  - テストシナリオHAL: [tests/scenarios/P01_frdmIMX/hal/ARCHITECTURE_MANIFEST.md](file:///workspaces/FPGA-BoardlessBench/tests/scenarios/P01_frdmIMX/hal/ARCHITECTURE_MANIFEST.md)
  - テストシナリオAMR: [tests/scenarios/P02_robot_amr_ros2/ARCHITECTURE_MANIFEST.md](file:///workspaces/FPGA-BoardlessBench/tests/scenarios/P02_robot_amr_ros2/ARCHITECTURE_MANIFEST.md)
  - ダッシュボード: [dashboard/ARCHITECTURE_MANIFEST.md](file:///workspaces/FPGA-BoardlessBench/dashboard/ARCHITECTURE_MANIFEST.md)
  - スクリプト: [scripts/ARCHITECTURE_MANIFEST.md](file:///workspaces/FPGA-BoardlessBench/scripts/ARCHITECTURE_MANIFEST.md)
- **コード編集前の設計照合（Manifest Checking）の徹底**: どんなに軽微な修正やデバッグ・機能追加であっても、コードを書き換える前に必ず修正対象コンポーネントの `ARCHITECTURE_MANIFEST.md` および関連ドキュメントを参照・照合し、設計規約やアーキテクチャ原則（SoC/ベンダー非依存、Single Source of Truth など）に反していないことを思考プロセス（thought）内で検証すること。単に「テストがPASSする」ことだけでなく、「設計原則が維持されていること」を合否基準とすること。
- **不具合指摘対応時の即時修正禁止と冷静な影響考察**: ユーザーから不具合の指摘やバグ報告を受けた際であっても、焦ってすぐに手元のコードを書き換えようとせず、まず落ち着いてシステム全体の仕様・関連ドキュメントを再確認し、変更によるシステム全体への影響範囲を十分に考察した上で修正案を検討・提示すること。対症療法的な局所パッチ（特定名前の直叩き等）は厳禁とする。
- **Git管理・.gitignore判断時の歴史的意図（ADR）確認プロトコル**: Git管理下のファイルを除外・削除、または `.gitignore` を編集する際は、一般的な教科書的ビルド原則（例: 「生成物はGitに入れない」）を機械的に適用せず、必ず事前に [docs/architecture/AddInfo_history.md](file:///workspaces/FPGA-BoardlessBench/docs/architecture/AddInfo_history.md) や関連マニフェストを参照し、初学者の開発体験（`git clone` 直後の VS Code IntelliSense / clangd エラー防止のための `vfpga_device_config.h` 保持など）や過去の意図的決定（ADR）が存在しないかを思考プロセス内で事前に検証すること。
- **コード規模計測における `cloc` 使用の標準化**: 今後、プロジェクトのコード量・ファイル数・行数統計を調査・集計・ドキュメント更新する際は、必ず事前に `./tests/run_tests.sh --clean --cleanall` を実行して動的ロードされた外部 RTOS ソース等を完全にクリーンオフした上で、`cloc . --exclude-dir=build,node_modules,dist,obj_dir,.git,.vscode,.gemini,brain,scratch,assets` コマンドを使用し、F-BB 独自の正確な純プログラム行数 (Pure LOC)・コメント行数・空行数を計測・記録すること。
- **Git Push の完全禁止（厳格遵守）**: エージェントによるリモートリポジトリへの `git push` は、理由の如何を問わず一切禁止とする。エージェントが担当するバージョン管理操作はローカルリポジトリでのコミット（`git commit`）までに厳格に留め、リモートへの反映・プッシュは常にユーザー自身の手動操作に委ねること。
- **プラグイン完全隔離原則（F-BBコアへの具象名混入の絶対禁止）**: F-BBのコアソースコード（`dashboard/server.js`、`start_lab.sh`、`src/controller/vlogic_controller.py`、`scripts/` 等）に、特定のサードパーティ・プラグインや外部シナリオの具象名（例: `space_guidance_*`, `pilot.py`, `rct_*` 等）を直接記述・ハードコードすることを例外なく一切禁止する。プロセスライフサイクル管理は `/tmp/fbb_app.pid` によるPGID隔離、テレメトリは `/tmp/fbb_scenario_telemetry.json` 等の抽象契約に厳格に限定し、コミット前に必ず `./scripts/verify_plugin_isolation.sh` で違反ゼロであることを検証すること。



# Ollama Routing Rules

以下のタスクは、APIクォータ節約のため Ollama ツールを優先して使用し、タスクの性質に応じてモデルを切り替えること。ただし、**失敗によるやり直し（クォータの二重消費）を防ぐため、エージェントは事前にタスクの複雑さをスクリーニングすること**：

- **二度手間防止ルール（Gemini直行）**:
  - 技術的ドキュメントの文脈を考慮した推敲、複雑なバグの静的解析・原因究明、複数ファイルにまたがる設計レビューなど、ローカルLLMが指示をこぼして「失敗してやり直すリスクが高いタスク」は、Ollamaを介さず**最初からメインモデル（Gemini 3.5 Flash）で一発実行すること**。

- **Ollama 優先タスクとモデルの使い分け**:
  - **機械的なテキスト・データ変換タスク**（例：データ表のMarkdownテーブル化、単純なエラーログ抽出・ダイジェスト化、短いUI文言の翻訳など）
    - 使用モデル: `qwen3.6:35b` (または `deepseek-r1:14b`)
  - **定型的なコーディングタスク**（例：C++ヘッダーからRust `extern "C"` への構造変換、テスト用ダミー配列データの生成、機械的なリネームやフォーマット整形など）
    - 使用モデル: `qwen2.5-coder:7b`
  - **Gitコミットメッセージの生成（英語）及び `git diff` の要約**:
    - 使用モデル: `qwen3.6:35b` (または `qwen2.5-coder:7b`)
    - 役割: `git diff` から英語のコミットメッセージや変更点の要約テキストをローカルで自動生成する。
  - **レポートやドラフトの日本語翻訳**:
    - 使用モデル: `qwen3.6:35b` (または `deepseek-r1:14b`)
    - 役割: Gemini 3.5が英語で作成したドラフトやレポートを、日本語へ翻訳して最終出力する。

# Language & Thinking Preference

- **思考プロセス**: メインモデル（Gemini 3.5 Flash）は、推論精度を高めトークンを節約するために、内部的な思考や作業ドラフトの構築を英語で行うこと。
- **レポートの出力**: 英語で指示された場合であっても、回答やレポートは常に日本語で出力すること。
- **翻訳のOllama委譲**: 英語で構成した思考やドラフトを日本語のレポートとして出力する際、翻訳処理はローカルLLMであるOllama（`qwen3.6:35b`）を使用して実行すること。
  - **Ollama待機時の節約ルール**: Ollamaの処理をバックグラウンドで走らせている間（応答待ちの間）は、メインモデル（Gemini 3.5 Flash）のトークンを無駄に消費しないよう、中間報告や詳細な進捗解説、余計な診断コマンドの実行を避け、最小限のステータス（1行程度）を出力して静かにタイマーで待機すること。
  - **Docker環境でのOllamaホスト指定**: DockerコンテナからホストPC側のOllamaサーバーへ接続する際は、必ず環境変数 `OLLAMA_HOST=host.docker.internal:11434` を付与して実行すること。

# 順法セルフチェック・プロトコル (Compliance Self-Check Protocol)

エージェントは、ツール呼び出しや最終回答の出力を行う前に、**必ず思考プロセス（thought）内で以下のチェックリストを自己検証し、思考ログに明記すること。** この自己検証ステップの省略は規約違反とみなされます。

1. **Ollama優先タスクの確認**:
   - 実行しようとしている作業に「Gitコミットメッセージ生成」「翻訳・ダイジェスト化」「定型コーディング」が含まれるか？
   - **含まれる場合**: メインモデル側で直接ドラフトテキストを作成・実行せず、必ず `ollama-mcp` ツールを介してローカルモデルに委託すること。
   - **含まれない場合**: メインモデルで実行する妥当な理由（例：「複雑なC++バグ解析のため」等）を思考プロセスに1行記述すること。
2. **実行前の最終ゲートチェック**:
   - コミット実行時、メッセージは Ollama から返ってきた出力結果を適用しているか？
   - コミットの実行前に、必ずユーザーのレビューおよび明示的な承認（レビュー終了の合意）を得ているか？（**厳守項目**）
3. **Git Push の完全禁止（厳守項目）**:
   - エージェントはいかなる状況下であっても `git push` コマンドを実行してはならない。エージェントが担当する Git 操作はローカルでのコミット（`git commit`）までに厳格に限定し、リモートリポジトリへのプッシュはすべてユーザー自身の手動操作に委ねること。
