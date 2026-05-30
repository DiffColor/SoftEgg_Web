# SoftEgg Web

현재 Flutter 기반 SoftEgg 패키징 도구를 React 기반 정적 웹 앱으로 옮긴 버전입니다.

## 핵심 동작

- 5자리 회사 코드로 운영 카탈로그 조회
- 그룹/이름/버전/OS 기준 소프트웨어 선택
- 백엔드 API가 FTP 아티팩트를 전달
- 브라우저에서 xxHash64 검증 후 `.segg` 생성
- 사용자 경로 선택 없이 임시 작업 공간에서 처리 후 자동 다운로드
- 데스크탑/모바일 반응형 UI

## 로컬 실행

```bash
npm install
npm run dev
```

프런트엔드 개발 서버는 `5173` 포트에서 실행됩니다.
백엔드 API는 별도로 실행 중이어야 하며, 프런트는 `VITE_API_BASE_URL`로 직접 연결합니다.

## 빌드

```bash
npm run build
```

## 환경 변수

`.env.example`을 복사해 `VITE_API_BASE_URL`을 설정하십시오.

```bash
cp .env.example .env
```

예시:

```bash
VITE_API_BASE_URL=https://license.turtlelab.app
```

## Cloudflare Pages 배포

Cloudflare Pages 환경 변수에 `VITE_API_BASE_URL`을 등록하고 `npm run build` 결과물 `dist`를 배포하십시오.
