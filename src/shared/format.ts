export function formatBytes(value: number): string {
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(2)} KB`;
  }
  return `${value} B`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function sanitizeSegment(value: string): string {
  const sanitized = value.replace(/[^\w.-]+/g, "_");
  return sanitized.length > 0 ? sanitized : "artifact";
}

export function buildPackageFileName(name: string, version: string): string {
  return `${sanitizeSegment(name)}_${sanitizeSegment(version)}.segg`;
}

export function humanizeTask(rawTask: string): string {
  if (rawTask.includes("메인 바이너리")) {
    if (rawTask.includes("재연결")) {
      return "주요 파일 준비를 다시 시도하는 중";
    }
    if (rawTask.includes("체크섬")) {
      return "주요 파일 확인 중";
    }
    if (rawTask.includes("완료")) {
      return "주요 파일 준비 완료";
    }
    return "주요 파일 준비 중";
  }
  if (rawTask.includes("의존성")) {
    if (rawTask === "의존성 없음") {
      return "추가 구성 요소 없음";
    }
    if (rawTask.includes("재연결")) {
      return "추가 구성 요소 준비를 다시 시도하는 중";
    }
    if (rawTask.includes("체크섬")) {
      return "추가 구성 요소 확인 중";
    }
    if (rawTask.includes("완료")) {
      return "추가 구성 요소 준비 완료";
    }
    return "추가 구성 요소 준비 중";
  }
  if (rawTask.includes("매니페스트")) {
    return "패키지 정보 정리 중";
  }
  if (rawTask.includes(".segg")) {
    return "패키지 파일 정리 중";
  }
  if (rawTask.includes("패키징 완료")) {
    return "패키지 생성 완료";
  }
  return rawTask;
}

export function humanizeLog(rawMessage: string): string {
  if (rawMessage.includes("다운로드를 시작합니다")) {
    return "필요한 파일을 준비하고 있습니다.";
  }
  if (rawMessage.includes("체크섬을 검증합니다")) {
    return "준비한 파일을 확인하고 있습니다.";
  }
  if (rawMessage.includes("다운로드 및 검증이 완료되었습니다")) {
    return "파일 준비가 완료되었습니다.";
  }
  if (rawMessage.includes("선택된 의존성이 없어 다음 단계로 진행합니다")) {
    return "추가로 준비할 항목이 없어 다음 단계로 진행합니다.";
  }
  if (rawMessage.includes("패키지 내부 매니페스트를 작성합니다")) {
    return "패키지 정보를 정리하고 있습니다.";
  }
  if (rawMessage.includes("압축 아카이브를 생성합니다")) {
    return "패키지 파일을 만들고 있습니다.";
  }
  if (rawMessage.includes("아카이브 구성")) {
    return "패키지 파일을 정리하고 있습니다.";
  }
  if (rawMessage.includes("원격 크기를 확인합니다")) {
    return "필요한 파일 정보를 확인하고 있습니다.";
  }
  return rawMessage
    .replaceAll("메인 바이너리", "주요 파일")
    .replaceAll("의존성", "추가 구성 요소")
    .replaceAll("체크섬", "확인")
    .replaceAll("매니페스트", "패키지 정보")
    .replaceAll(".segg", "패키지 파일")
    .replaceAll("FTP", "")
    .trim();
}
