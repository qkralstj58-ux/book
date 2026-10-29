# book
budget book

빠르게 입력하고 바로 확인하는 개인용 가계부 PWA입니다.

- 앱 주소: https://qkralstj58-ux.github.io/book/
- 아이폰: Safari로 접속 → 공유 → **홈 화면에 추가**

## 구성

| 파일 | 내용 |
| --- | --- |
| `index.html` | 메인 화면(날짜 · 일/주/월 요약 · 입력 · 기록 목록), 설정 시트 |
| `app.js` | 앱 로직, IndexedDB 저장, JSON 백업/복원 |
| `style.css` | iOS 스타일 UI |
| `sw.js` | 오프라인 캐시 (파일 수정 시 `VERSION` 올리기) |
| `manifest.json`, `icons/` | PWA 설정과 아이콘 |

빌드 과정 없는 정적 파일이며, `main`에 푸시하면 GitHub Actions가 GitHub Pages로 배포합니다.

로컬 실행: `python3 -m http.server` 후 http://localhost:8000

데이터는 기기 브라우저(IndexedDB)에만 저장됩니다. 설정(⋯) → JSON 내보내기로 백업하세요.
