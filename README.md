# SoftEgg Web

현재 Flutter 기반 SoftEgg 패키징 도구를 React + Cloudflare Worker 조합으로 옮긴 웹 버전입니다.

## 핵심 동작

- 5자리 회사 코드로 운영 카탈로그 조회
- 제품군/버전/의존성 선택
- Cloudflare Worker가 FTP에 접속해 아티팩트 전달
- 브라우저에서 xxHash64 검증 후 `.segg` 생성
- 사용자 경로 선택 없이 임시 작업 공간에서 처리 후 자동 다운로드
- 데스크탑/모바일 반응형 UI

## 로컬 실행

```bash
npm install
npm run dev
```

프런트엔드 개발 서버는 `5173` 포트에서 실행됩니다.

Worker API를 함께 테스트하려면 별도 터미널에서 실행하십시오.

```bash
npm run dev:worker
```

## 빌드

```bash
npm run build
```

## Cloudflare 배포

```bash
npm run deploy
```

`wrangler.jsonc`에 현재 Flutter 앱과 동일한 운영 기본값이 들어 있습니다.
운영 환경에서는 Cloudflare secret 또는 환경별 설정으로 분리하는 것을 권장합니다.
