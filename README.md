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

## API 검증

현재 프로젝트의 Worker API 4종(`/api/health`, `/api/catalog/:companyCode`, `/api/artifact/size`, `/api/artifact/download`)과
카탈로그 파싱 로직은 다음 명령으로 로컬에서 한 번에 검증할 수 있습니다.

```bash
npm run verify:api
```

검증 스크립트는 모의 카탈로그 서버, 모의 FTP 서버, Wrangler Worker를 함께 띄운 뒤 실제 HTTP 요청과 응답 파싱까지 확인합니다.

## Cloudflare 배포

```bash
npm run deploy
```

민감한 서버 정보는 저장소에 두지 않습니다.

로컬 Worker 개발 시에는 셸 환경변수에 값을 넣고 `.dev.vars`를 생성하십시오.

```bash
export SOFTEGG_API_BASE_URL=https://example.com
export SOFTEGG_FTP_HOST=ftp.example.com
export SOFTEGG_FTP_PORT=21
export SOFTEGG_FTP_USER=your-user
export SOFTEGG_FTP_PASSWORD=your-password
npm run setup:worker-env
```

`.dev.vars.example`는 필요한 키 목록 확인용 예시 파일입니다. FTP가 기본 포트 `21`이 아닌 경우 `SOFTEGG_FTP_PORT`를 함께 설정하십시오.

운영 배포 시에는 다음 기준으로 관리하십시오.

- 변수: `SOFTEGG_API_BASE_URL`, `SOFTEGG_FTP_HOST`, `SOFTEGG_FTP_PORT`, `SOFTEGG_FTP_USER`
- 시크릿: `SOFTEGG_FTP_PASSWORD`

비밀번호는 Cloudflare Secret으로 등록하십시오.

```bash
wrangler secret put SOFTEGG_FTP_PASSWORD
```

Worker는 위 값이 없으면 요청 처리 시 즉시 오류를 반환합니다.
