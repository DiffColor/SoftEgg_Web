import { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import {
  buildGroups,
  canPackage,
  createManifest,
  getDependencyKey,
  getFileName,
  hasUri,
  parseCompanyCatalog,
  type CompanyCatalog,
  type PackagingArtifactRecord,
  type RemoteInstallEntry,
  type RemoteSoftwareBinary,
  type RemoteSoftwarePackage,
  type SoftwareGroupViewModel,
} from "../shared/models";
import {
  buildPackageFileName,
  formatBytes,
  formatDateTime,
  humanizeLog,
  humanizeTask,
  sanitizeSegment,
} from "../shared/format";
import { computeXxHash64 } from "../shared/xxhash64";

type StepIndex = 0 | 1 | 2 | 3;
type LogLevel = "INFO" | "WARN" | "ERROR" | "DONE";
type NoticeTone = "info" | "success" | "warning" | "danger";

interface LogLine {
  id: string;
  timestamp: Date;
  level: LogLevel;
  message: string;
}

interface Notice {
  id: string;
  title: string;
  message: string;
  tone: NoticeTone;
}

interface PackagingResultViewModel {
  packageFileName: string;
  packageSizeBytes: number;
  mainArtifact: PackagingArtifactRecord;
  dependencyArtifacts: PackagingArtifactRecord[];
  generatedAt: string;
  selectedPackage: RemoteSoftwarePackage;
  company: CompanyCatalog["company"];
  blob: Blob;
}

interface SelectOption {
  value: string;
  label: string;
}

const PARTNER_CODE_LENGTH = 5;
const STEP_LABELS = ["Partner Access", "Configuration", "Packaging", "Completion"];
const API_BASE_URL = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL);

export function App() {
  const [currentStep, setCurrentStep] = useState<StepIndex>(0);
  const [partnerCodeInputs, setPartnerCodeInputs] = useState<string[]>(
    Array.from({ length: PARTNER_CODE_LENGTH }, () => ""),
  );
  const [isHealthLoading, setIsHealthLoading] = useState(true);
  const [isCatalogServerChecking, setIsCatalogServerChecking] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [catalogServerCheckedAt, setCatalogServerCheckedAt] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CompanyCatalog | null>(null);
  const [softwareGroups, setSoftwareGroups] = useState<SoftwareGroupViewModel[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [selectedPackageId, setSelectedPackageId] = useState<string>("");
  const [selectedDependencyKeys, setSelectedDependencyKeys] = useState<string[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [isCatalogLoading, setIsCatalogLoading] = useState(false);
  const [remoteSizeCache, setRemoteSizeCache] = useState<Record<string, number | null>>({});
  const [remoteSizeLoading, setRemoteSizeLoading] = useState<Record<string, boolean>>({});
  const [packagingProgress, setPackagingProgress] = useState(0);
  const [currentTaskLabel, setCurrentTaskLabel] = useState("대기 중");
  const [packagingError, setPackagingError] = useState<string | null>(null);
  const [packagingLogs, setPackagingLogs] = useState<LogLine[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [isPackagingRunning, setIsPackagingRunning] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [currentProcessedBytes, setCurrentProcessedBytes] = useState<number | null>(null);
  const [currentTotalBytes, setCurrentTotalBytes] = useState<number | null>(null);
  const [currentBytesPerSecond, setCurrentBytesPerSecond] = useState<number | null>(null);
  const [packagingResult, setPackagingResult] = useState<PackagingResultViewModel | null>(null);

  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const packagingAbortControllerRef = useRef<AbortController | null>(null);
  const packagingCancelledRef = useRef(false);
  const elapsedTimerRef = useRef<number | null>(null);
  const completionTimerRef = useRef<number | null>(null);
  const activeSessionIdRef = useRef<number | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  const partnerCode = normalizeCompanyCodeInput(partnerCodeInputs.join(""));
  const isPartnerCodeComplete = /^[A-Z0-9]{5}$/.test(partnerCode);
  const runtimeEngineStatus = healthError == null ? "edge runtime ready" : "runtime check required";
  const runtimeCatalogStatus = healthError == null ? "catalog service connected" : "catalog service unavailable";

  const selectedGroup = softwareGroups.find((group) => group.id === selectedGroupId) ?? null;
  const selectedPackage =
    selectedGroup?.packages.find((item) => item.id === selectedPackageId) ?? null;
  const selectedDependencyKeySet = new Set(selectedDependencyKeys);
  const selectedDependencies =
    selectedPackage?.dependencies.filter((item) => selectedDependencyKeySet.has(getDependencyKey(item))) ??
    [];
  const canStartPackaging = selectedPackage != null && canPackage(selectedPackage, selectedDependencyKeySet);

  useEffect(() => {
    void probeHealth();
    return () => {
      if (elapsedTimerRef.current != null) {
        window.clearInterval(elapsedTimerRef.current);
      }
      if (completionTimerRef.current != null) {
        window.clearTimeout(completionTimerRef.current);
      }
      packagingAbortControllerRef.current?.abort();
      releaseBlobUrl();
    };
  }, []);

  useEffect(() => {
    if (selectedPackage == null) {
      return;
    }
    void primeRemoteSizes(selectedPackage);
  }, [selectedPackageId, selectedGroupId]);

  async function probeHealth(): Promise<void> {
    setIsHealthLoading(true);
    setIsCatalogServerChecking(true);
    setHealthError(null);
    try {
      await probeCatalogServerRequest();
      setCatalogServerCheckedAt(new Date().toISOString());
    } catch (error) {
      logClientError("health probe failed", error);
      setHealthError(toHealthUiMessage(error));
      setCatalogServerCheckedAt(new Date().toISOString());
    } finally {
      setIsHealthLoading(false);
      setIsCatalogServerChecking(false);
    }
  }

  async function authorizePartnerCode(): Promise<void> {
    if (!isPartnerCodeComplete || isCatalogLoading) {
      return;
    }

    setIsCatalogLoading(true);
    setCatalogError(null);

    try {
      const nextCatalog = await fetchCatalogRequest(partnerCode);
      if (nextCatalog.softwarePackages.length === 0) {
        throw new Error("할당된 소프트웨어가 없습니다.");
      }

      const groups = buildGroups(nextCatalog);
      if (groups.length === 0) {
        throw new Error("표시 가능한 소프트웨어가 없습니다.");
      }

      const firstGroup = groups[0];
      const firstPackage = firstGroup.packages[0];
      setCatalog(nextCatalog);
      setSoftwareGroups(groups);
      setSelectedGroupId(firstGroup.id);
      setSelectedPackageId(firstPackage.id);
      setSelectedDependencyKeys(
        firstPackage.dependencies.filter(hasUri).map((item) => getDependencyKey(item)),
      );
      setCatalogServerCheckedAt(new Date().toISOString());
      setCurrentStep(1);
      appendLog(
        "INFO",
        `카탈로그 조회 완료: ${nextCatalog.company.companyName} (${nextCatalog.company.companyCode})`,
      );
      showNotice(
        "카탈로그 조회 완료",
        `${nextCatalog.company.companyName}에 할당된 ${nextCatalog.softwarePackages.length}개 패키지를 불러왔습니다.`,
        "success",
      );
    } catch (error) {
      logClientError("catalog authorization failed", error, { partnerCode });
      const message = toCatalogUiMessage(error);
      setCatalogError(message);
      appendLog("ERROR", message);
      showNotice("카탈로그 조회 실패", message, "danger");
    } finally {
      setIsCatalogLoading(false);
    }
  }

  async function primeRemoteSizes(targetPackage: RemoteSoftwarePackage): Promise<void> {
    const binaries = [targetPackage.mainBinary, ...targetPackage.dependencies].filter(hasUri);
    for (const binary of binaries) {
      const uri = binary.uri.trim();
      if (!uri || remoteSizeCache[uri] !== undefined || remoteSizeLoading[uri]) {
        continue;
      }
      setRemoteSizeLoading((current) => ({ ...current, [uri]: true }));
      try {
        const size = await fetchRemoteSize(binary.uri);
        setRemoteSizeCache((current) => ({ ...current, [uri]: size }));
      } catch (error) {
        logClientError("remote size probe failed", error, { uri });
        setRemoteSizeCache((current) => ({ ...current, [uri]: null }));
      } finally {
        setRemoteSizeLoading((current) => ({ ...current, [uri]: false }));
      }
    }
  }

  async function refreshRemoteSizes(): Promise<void> {
    if (selectedPackage == null) {
      return;
    }
    const nextCache = { ...remoteSizeCache };
    const nextLoading = { ...remoteSizeLoading };
    for (const binary of [selectedPackage.mainBinary, ...selectedPackage.dependencies]) {
      if (!hasUri(binary)) {
        continue;
      }
      delete nextCache[binary.uri.trim()];
      delete nextLoading[binary.uri.trim()];
    }
    setRemoteSizeCache(nextCache);
    setRemoteSizeLoading(nextLoading);
    await primeRemoteSizes(selectedPackage);
  }

  async function fetchRemoteSize(uri: string): Promise<number | null> {
    const payload = await requestJson("/api/public/software-artifact/size", {
      method: "POST",
      body: { uri },
      requestErrorMessage: "원격 파일 크기 조회에 실패했습니다.",
      invalidJsonMessage: "원격 파일 크기 응답을 처리하지 못했습니다.",
    });
    return typeof payload.size === "number" ? payload.size : null;
  }

  function updateSelectedGroup(groupId: string): void {
    const nextGroup = softwareGroups.find((item) => item.id === groupId) ?? softwareGroups[0];
    if (!nextGroup) {
      return;
    }
    const nextPackage = nextGroup.packages[0];
    setSelectedGroupId(nextGroup.id);
    setSelectedPackageId(nextPackage.id);
    setSelectedDependencyKeys(
      nextPackage.dependencies.filter(hasUri).map((item) => getDependencyKey(item)),
    );
    setPackagingError(null);
  }

  function updateSelectedPackage(packageId: string): void {
    if (!selectedGroup) {
      return;
    }
    const nextPackage =
      selectedGroup.packages.find((item) => item.id === packageId) ?? selectedGroup.packages[0];
    if (!nextPackage) {
      return;
    }
    setSelectedPackageId(nextPackage.id);
    setSelectedDependencyKeys(
      nextPackage.dependencies.filter(hasUri).map((item) => getDependencyKey(item)),
    );
    setPackagingError(null);
  }

  function toggleDependency(key: string, checked: boolean): void {
    setSelectedDependencyKeys((current) => {
      if (checked) {
        return current.includes(key) ? current : [...current, key];
      }
      return current.filter((item) => item !== key);
    });
  }

  async function startPackaging(): Promise<void> {
    if (catalog == null || selectedPackage == null || !canStartPackaging || isPackagingRunning) {
      return;
    }

    const sessionId = Date.now();
    activeSessionIdRef.current = sessionId;
    packagingCancelledRef.current = false;
    packagingAbortControllerRef.current?.abort();
    const controller = new AbortController();
    packagingAbortControllerRef.current = controller;

    if (elapsedTimerRef.current != null) {
      window.clearInterval(elapsedTimerRef.current);
    }
    if (completionTimerRef.current != null) {
      window.clearTimeout(completionTimerRef.current);
    }

    setCurrentStep(2);
    setIsPackagingRunning(true);
    setPackagingProgress(0.01);
    setCurrentTaskLabel("작업 시작");
    setPackagingError(null);
    setPackagingResult(null);
    setPackagingLogs([]);
    setElapsedSeconds(0);
    setCurrentProcessedBytes(null);
    setCurrentTotalBytes(null);
    setCurrentBytesPerSecond(null);
    releaseBlobUrl();

    appendLog(
      "INFO",
      `패키징 시작: ${catalog.company.companyName} / ${selectedPackage.name} ${selectedPackage.version}`,
    );

    elapsedTimerRef.current = window.setInterval(() => {
      setElapsedSeconds((current) => current + 1);
    }, 1000);

    try {
      const allArtifacts = [selectedPackage.mainBinary, ...selectedDependencies];
      const artifactSizes = await resolveArtifactSizes(allArtifacts, sessionId);
      const slices = buildArtifactSlices(allArtifacts, artifactSizes, 0.05, 0.97, 0.02);

      const zip = new JSZip();
      const dependencyArtifacts: PackagingArtifactRecord[] = [];
      const mainNames = new Set<string>();
      const dependencyNames = new Set<string>();

      updatePackagingProgress(0.02, "작업 디렉터리 준비", {
        level: "INFO",
        message: "브라우저 임시 작업 공간을 구성했습니다.",
        clearMetrics: true,
      });

      const mainArtifact = await downloadArtifact({
        binary: selectedPackage.mainBinary,
        labelPrefix: "메인 바이너리",
        progressStart: slices[selectedPackage.mainBinary.uri.trim()][0],
        progressEnd: slices[selectedPackage.mainBinary.uri.trim()][1],
        signal: controller.signal,
        sessionId,
        usedFileNames: mainNames,
      });
      zip.file(`main/${mainArtifact.record.fileName}`, mainArtifact.data);

      if (selectedDependencies.length > 0) {
        for (const [index, dependency] of selectedDependencies.entries()) {
          throwIfSessionInvalid(sessionId);
          const slice = slices[dependency.uri.trim()];
          const artifact = await downloadArtifact({
            binary: dependency,
            labelPrefix: `의존성 ${index + 1}/${selectedDependencies.length}`,
            progressStart: slice[0],
            progressEnd: slice[1],
            signal: controller.signal,
            sessionId,
            usedFileNames: dependencyNames,
          });
          dependencyArtifacts.push(artifact.record);
          zip.file(`dependencies/${artifact.record.fileName}`, artifact.data);
        }
      } else {
        updatePackagingProgress(0.97, "의존성 없음", {
          level: "INFO",
          message: "선택된 의존성이 없어 다음 단계로 진행합니다.",
          clearMetrics: true,
        });
      }

      const packageFileName = buildPackageFileName(selectedPackage.name, selectedPackage.version);
      const generatedAt = new Date().toISOString();
      const manifest = createManifest({
        company: catalog.company,
        selectedPackage,
        mainArtifact: mainArtifact.record,
        dependencyArtifacts,
        generatedAt,
        packageFileName,
      });

      updatePackagingProgress(0.975, "매니페스트 생성", {
        level: "INFO",
        message: "패키지 내부 매니페스트를 작성합니다.",
        clearMetrics: true,
      });
      zip.file("manifest.json", JSON.stringify(manifest, null, 2));

      updatePackagingProgress(0.985, ".segg 생성", {
        level: "INFO",
        message: "압축 아카이브를 생성합니다.",
        clearMetrics: true,
      });

      const blob = await zip.generateAsync(
        {
          type: "blob",
          compression: "DEFLATE",
          compressionOptions: {
            level: 6,
          },
        },
        (metadata) => {
          throwIfSessionInvalid(sessionId);
          const progress = Math.min(0.995, 0.985 + metadata.percent / 100 / 100);
          setPackagingProgress(progress);
          setCurrentTaskLabel(".segg 생성 중");
          setCurrentProcessedBytes(null);
          setCurrentTotalBytes(null);
          setCurrentBytesPerSecond(null);
        },
      );

      throwIfSessionInvalid(sessionId);
      const sizeBytes = blob.size;
      updatePackagingProgress(1, "패키징 완료", {
        level: "DONE",
        message: `패키지를 생성했습니다: ${packageFileName}`,
        clearMetrics: true,
      });

      setPackagingResult({
        packageFileName,
        packageSizeBytes: sizeBytes,
        mainArtifact: mainArtifact.record,
        dependencyArtifacts,
        generatedAt,
        selectedPackage,
        company: catalog.company,
        blob,
      });
      triggerDownload(blob, packageFileName);
      showNotice("패키징 완료", `${packageFileName} 다운로드를 시작했습니다.`, "success");
      completionTimerRef.current = window.setTimeout(() => {
        if (activeSessionIdRef.current === sessionId) {
          setCurrentStep(3);
        }
      }, 1600);
    } catch (error) {
      logClientError("packaging failed", error, {
        currentTaskLabel,
        selectedPackageId,
        selectedGroupId,
      });
      if (activeSessionIdRef.current !== sessionId) {
        return;
      }
      const message = toPackagingUiMessage(error);
      if (message === "작업이 중단되었습니다.") {
        showNotice("작업 중단", "현재 작업을 중단하고 이전 단계로 이동했습니다.", "warning");
        setCurrentStep(1);
      } else {
        setPackagingError(message);
        appendLog("ERROR", message);
        showNotice("패키징 실패", message, "danger");
      }
    } finally {
      if (activeSessionIdRef.current === sessionId) {
        setIsPackagingRunning(false);
        setCurrentProcessedBytes(null);
        setCurrentTotalBytes(null);
        setCurrentBytesPerSecond(null);
        packagingAbortControllerRef.current = null;
      }
      if (elapsedTimerRef.current != null) {
        window.clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
    }
  }

  async function resolveArtifactSizes(
    binaries: RemoteSoftwareBinary[],
    sessionId: number,
  ): Promise<Record<string, number | null>> {
    const results: Record<string, number | null> = {};
    for (const [index, binary] of binaries.entries()) {
      throwIfSessionInvalid(sessionId);
      updatePackagingProgress(0.03 + 0.04 * ((index + 1) / binaries.length), "원격 파일 정보 확인", {
        level: "INFO",
        message: `${getFileName(binary)} 원격 크기를 확인합니다.`,
        clearMetrics: true,
      });
      const size =
        remoteSizeCache[binary.uri.trim()] !== undefined
          ? remoteSizeCache[binary.uri.trim()]
          : await fetchRemoteSize(binary.uri);
      results[binary.uri.trim()] = size;
      setRemoteSizeCache((current) => ({ ...current, [binary.uri.trim()]: size }));
    }
    return results;
  }

  async function downloadArtifact(options: {
    binary: RemoteSoftwareBinary;
    labelPrefix: string;
    progressStart: number;
    progressEnd: number;
    signal: AbortSignal;
    sessionId: number;
    usedFileNames: Set<string>;
  }): Promise<{ record: PackagingArtifactRecord; data: Uint8Array }> {
    const { binary, labelPrefix, progressStart, progressEnd, signal, sessionId, usedFileNames } =
      options;
    const fileName = getFileName(binary);

    updatePackagingProgress(progressStart, `${labelPrefix} 다운로드 시작`, {
      level: "INFO",
      message: `${fileName} 다운로드를 시작합니다.`,
      processedBytes: 0,
    });

    const response = await fetch(buildApiUrl("/api/public/software-artifact/download"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        uri: binary.uri,
        checksum: binary.checksum,
        fileName,
      }),
      signal,
    });

    if (!response.ok || response.body == null) {
      throw new Error(await readApiErrorMessage(response, "FTP 다운로드에 실패했습니다."));
    }

    const totalBytes =
      Number.parseInt(response.headers.get("x-softegg-size") ?? "", 10) ||
      Number.parseInt(response.headers.get("content-length") ?? "", 10) ||
      0;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    let lastBytes = 0;
    let lastElapsedMs = 0;
    const startedAt = performance.now();
    const downloadEnd = progressStart + (progressEnd - progressStart) * 0.9;

    try {
      while (true) {
        throwIfSessionInvalid(sessionId);
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        chunks.push(value);
        receivedBytes += value.byteLength;
        const progress = totalBytes > 0 ? receivedBytes / totalBytes : 1;
        const elapsedMs = performance.now() - startedAt;
        const deltaMs = elapsedMs - lastElapsedMs;
        const deltaBytes = receivedBytes - lastBytes;
        const bytesPerSecond = deltaMs > 0 ? (deltaBytes * 1000) / deltaMs : 0;
        lastBytes = receivedBytes;
        lastElapsedMs = elapsedMs;
        updatePackagingProgress(
          progressStart + (downloadEnd - progressStart) * progress,
          `${labelPrefix} 다운로드 중`,
          {
            level: "INFO",
            message:
              `${fileName} ${(progress * 100).toFixed(0)}% · ${formatBytes(receivedBytes)}` +
              (totalBytes > 0 ? ` / ${formatBytes(totalBytes)}` : "") +
              (bytesPerSecond > 0 ? ` · ${formatBytes(Math.round(bytesPerSecond))}/s` : ""),
            loggable: false,
            processedBytes: receivedBytes,
            totalBytes: totalBytes > 0 ? totalBytes : null,
            bytesPerSecond: bytesPerSecond > 0 ? bytesPerSecond : null,
          },
        );
      }
    } finally {
      reader.releaseLock();
    }

    const data = concatenateUint8Arrays(chunks);

    updatePackagingProgress(downloadEnd, `${labelPrefix} 체크섬 검증`, {
      level: "INFO",
      message: `${fileName} 체크섬을 검증합니다.`,
    });

    const checksum = await computeXxHash64(
      data,
      (progress, processedBytes, verifyTotalBytes) => {
        throwIfSessionInvalid(sessionId);
        updatePackagingProgress(
          downloadEnd + (progressEnd - downloadEnd) * (progress / 100),
          `${labelPrefix} 체크섬 검증 중`,
          {
            level: "INFO",
            message: `${fileName} 체크섬 ${progress.toFixed(0)}% · ${formatBytes(processedBytes)} / ${formatBytes(verifyTotalBytes)}`,
            loggable: false,
            processedBytes,
            totalBytes: verifyTotalBytes,
          },
        );
      },
      () => packagingCancelledRef.current || activeSessionIdRef.current !== sessionId,
    );

    const expectedChecksum = binary.checksum.trim().toLowerCase();
    if (expectedChecksum && checksum !== expectedChecksum) {
      throw new Error(`체크섬 검증에 실패했습니다: ${fileName} (expected ${expectedChecksum})`);
    }

    const safeName = makeSafeArchiveFileName(fileName, usedFileNames);
    updatePackagingProgress(progressEnd, `${labelPrefix} 완료`, {
      level: "INFO",
      message: `${fileName} 다운로드 및 검증이 완료되었습니다. (${formatBytes(data.byteLength)})`,
      processedBytes: data.byteLength,
      totalBytes: data.byteLength,
      clearMetrics: true,
    });

    return {
      record: {
        kind: labelPrefix.startsWith("메인") ? "main" : "dependency",
        fileName: safeName,
        archivePath: `${labelPrefix.startsWith("메인") ? "main" : "dependencies"}/${safeName}`,
        checksum: expectedChecksum || checksum,
        sizeBytes: data.byteLength,
      },
      data,
    };
  }

  function stopPackaging(): void {
    if (!isPackagingRunning) {
      return;
    }
    packagingCancelledRef.current = true;
    activeSessionIdRef.current = null;
    packagingAbortControllerRef.current?.abort();
    setIsPackagingRunning(false);
    setPackagingProgress(0);
    setCurrentTaskLabel("대기 중");
    setPackagingError(null);
    setPackagingResult(null);
    setPackagingLogs([]);
    setElapsedSeconds(0);
    setCurrentProcessedBytes(null);
    setCurrentTotalBytes(null);
    setCurrentBytesPerSecond(null);
    if (elapsedTimerRef.current != null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    if (completionTimerRef.current != null) {
      window.clearTimeout(completionTimerRef.current);
      completionTimerRef.current = null;
    }
    setCurrentStep(1);
  }

  function resetWizard(): void {
    if (isPackagingRunning) {
      return;
    }
    releaseBlobUrl();
    setCurrentStep(0);
    setPartnerCodeInputs(Array.from({ length: PARTNER_CODE_LENGTH }, () => ""));
    setCatalog(null);
    setSoftwareGroups([]);
    setSelectedGroupId("");
    setSelectedPackageId("");
    setSelectedDependencyKeys([]);
    setRemoteSizeCache({});
    setRemoteSizeLoading({});
    setCatalogError(null);
    setPackagingError(null);
    setPackagingResult(null);
    setPackagingLogs([]);
    setPackagingProgress(0);
    setCurrentTaskLabel("대기 중");
    setElapsedSeconds(0);
    setCurrentProcessedBytes(null);
    setCurrentTotalBytes(null);
    setCurrentBytesPerSecond(null);
    window.setTimeout(() => inputRefs.current[0]?.focus(), 0);
  }

  function startNewPackageFromCurrentAccess(): void {
    if (isPackagingRunning) {
      return;
    }
    releaseBlobUrl();
    setCurrentStep(1);
    setPackagingProgress(0);
    setCurrentTaskLabel("대기 중");
    setPackagingError(null);
    setPackagingResult(null);
    setPackagingLogs([]);
    setElapsedSeconds(0);
  }

  function copyLogs(): void {
    if (packagingLogs.length === 0) {
      return;
    }
    const text = [...packagingLogs]
      .reverse()
      .map((line) => `[${timeText(line.timestamp)}] ${line.level} ${line.message}`)
      .join("\n");
    void navigator.clipboard.writeText(text);
    showNotice("로그 복사 완료", `로그 ${packagingLogs.length}줄을 클립보드에 복사했습니다.`, "success");
  }

  function downloadResultAgain(): void {
    if (packagingResult == null) {
      return;
    }
    triggerDownload(packagingResult.blob, packagingResult.packageFileName);
  }

  function updatePackagingProgress(
    progress: number,
    task: string,
    options: {
      level: LogLevel;
      message: string;
      loggable?: boolean;
      processedBytes?: number | null;
      totalBytes?: number | null;
      bytesPerSecond?: number | null;
      clearMetrics?: boolean;
    },
  ): void {
    setPackagingProgress(Math.max(0, Math.min(1, progress)));
    setCurrentTaskLabel(task);
    if (options.clearMetrics) {
      setCurrentProcessedBytes(null);
      setCurrentTotalBytes(null);
      setCurrentBytesPerSecond(null);
    } else {
      setCurrentProcessedBytes(options.processedBytes ?? null);
      setCurrentTotalBytes(options.totalBytes ?? null);
      setCurrentBytesPerSecond(options.bytesPerSecond ?? null);
    }
    if (options.loggable !== false) {
      appendLog(options.level, options.message);
    }
  }

  function appendLog(level: LogLevel, message: string): void {
    setPackagingLogs((current) => {
      if (current[0]?.level === level && current[0]?.message === message) {
        return current;
      }
      return [
        {
          id: `${Date.now()}-${Math.random()}`,
          timestamp: new Date(),
          level,
          message,
        },
        ...current,
      ];
    });
  }

  function showNotice(title: string, message: string, tone: NoticeTone): void {
    const id = `${Date.now()}-${Math.random()}`;
    setNotices((current) => [...current, { id, title, message, tone }]);
    window.setTimeout(() => {
      setNotices((current) => current.filter((item) => item.id !== id));
    }, 3200);
  }

  function releaseBlobUrl(): void {
    if (blobUrlRef.current != null) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }

  function triggerDownload(blob: Blob, fileName: string): void {
    releaseBlobUrl();
    const url = URL.createObjectURL(blob);
    blobUrlRef.current = url;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  function throwIfSessionInvalid(sessionId: number): void {
    if (packagingCancelledRef.current || activeSessionIdRef.current !== sessionId) {
      throw new Error("작업이 중단되었습니다.");
    }
  }

  const estimatedPayloadLabel = useMemo(() => {
    if (selectedPackage == null) {
      return "-";
    }
    const expectedBinaries = [selectedPackage.mainBinary, ...selectedDependencies];
    let totalBytes = 0;
    let hasLoading = false;
    let hasUnknown = false;
    let hasMissing = false;

    for (const binary of expectedBinaries) {
      if (!hasUri(binary)) {
        hasMissing = true;
        continue;
      }
      const uri = binary.uri.trim();
      if (remoteSizeLoading[uri] || remoteSizeCache[uri] === undefined) {
        hasLoading = true;
        continue;
      }
      const size = remoteSizeCache[uri];
      if (size == null) {
        hasUnknown = true;
        continue;
      }
      totalBytes += size;
    }

    const totalLabel = formatBytes(totalBytes);
    if (hasLoading) {
      return totalBytes > 0 ? `${totalLabel} + 조회 중` : "조회 중";
    }
    if (hasMissing) {
      return totalBytes > 0 ? `${totalLabel} + 미등록` : "미등록 포함";
    }
    if (hasUnknown) {
      return totalBytes > 0 ? `${totalLabel} + 미확인` : "미확인";
    }
    return totalLabel;
  }, [remoteSizeCache, remoteSizeLoading, selectedDependencies, selectedPackage]);

  return (
    <div className="shell">
      <div className="shell__backdrop shell__backdrop--one" />
      <div className="shell__backdrop shell__backdrop--two" />
      <header className="topbar">
        <div className="brand">
          <div className="brand__mark">SE</div>
          <div>
            <div className="brand__title">SoftEgg</div>
            <div className="brand__subtitle">Responsive Packaging Console</div>
          </div>
        </div>
        <div className="topbar__meta">
          <Badge
            tone={isHealthLoading ? "info" : healthError == null ? "success" : "danger"}
            label={isHealthLoading ? "초기화 중" : healthError == null ? "LIVE READY" : "RUNTIME ERROR"}
          />
          {catalog != null ? <HeaderMeta label="파트너" value={catalog.company.companyName} /> : null}
        </div>
      </header>

      <nav className="stepper">
        {STEP_LABELS.map((label, index) => (
          <div key={label} className="stepper__item">
            <div
              className={[
                "stepper__index",
                index < currentStep ? "is-done" : "",
                index === currentStep ? "is-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {index < currentStep ? "OK" : index + 1}
            </div>
            <span className={index === currentStep ? "stepper__text is-active" : "stepper__text"}>
              {label}
            </span>
          </div>
        ))}
      </nav>

      <main className={currentStep === 0 ? "content content--gateway" : "content"}>
        {currentStep === 0 ? (
          <PartnerStep
            partnerCodeInputs={partnerCodeInputs}
            isPartnerCodeComplete={isPartnerCodeComplete}
            partnerCode={partnerCode}
            onChange={(index, value) => {
              const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 1);
              setPartnerCodeInputs((current) => {
                const next = [...current];
                next[index] = normalized;
                return next;
              });
              if (normalized && index < PARTNER_CODE_LENGTH - 1) {
                window.setTimeout(() => inputRefs.current[index + 1]?.focus(), 0);
              }
            }}
            onKeyDown={(index, event) => {
              if (event.key !== "Backspace") {
                return;
              }
              if (partnerCodeInputs[index]) {
                setPartnerCodeInputs((current) => {
                  const next = [...current];
                  next[index] = "";
                  return next;
                });
                return;
              }
              if (index > 0) {
                setPartnerCodeInputs((current) => {
                  const next = [...current];
                  next[index - 1] = "";
                  return next;
                });
                window.setTimeout(() => inputRefs.current[index - 1]?.focus(), 0);
              }
            }}
            inputRefs={inputRefs}
            isHealthLoading={isHealthLoading}
            isCatalogServerChecking={isCatalogServerChecking}
            healthError={healthError}
            catalogError={catalogError}
            runtimeEngineStatus={runtimeEngineStatus}
            runtimeCatalogStatus={runtimeCatalogStatus}
            catalogServerCheckedAt={catalogServerCheckedAt}
            isCatalogLoading={isCatalogLoading}
            onProbe={probeHealth}
          />
        ) : null}

        {currentStep === 1 && catalog != null && selectedGroup != null && selectedPackage != null ? (
          <ConfigurationStep
            catalog={catalog}
            softwareGroups={softwareGroups}
            selectedGroup={selectedGroup}
            selectedPackage={selectedPackage}
            selectedDependencyKeys={selectedDependencyKeySet}
            onSelectGroup={updateSelectedGroup}
            onSelectPackage={updateSelectedPackage}
            onToggleDependency={toggleDependency}
            onRefreshSizes={refreshRemoteSizes}
            remoteSizeCache={remoteSizeCache}
            remoteSizeLoading={remoteSizeLoading}
            estimatedPayloadLabel={estimatedPayloadLabel}
            canStartPackaging={canStartPackaging}
          />
        ) : null}

        {currentStep === 2 ? (
          <PackagingStep
            progress={packagingProgress}
            currentTaskLabel={currentTaskLabel}
            packagingError={packagingError}
            elapsedSeconds={elapsedSeconds}
            logs={packagingLogs}
            onCopyLogs={copyLogs}
            processedBytes={currentProcessedBytes}
            totalBytes={currentTotalBytes}
            bytesPerSecond={currentBytesPerSecond}
            dependencySummary={selectedPackage == null ? "0 / 0 selected" : `${selectedDependencies.length} / ${selectedPackage.dependencies.length} selected`}
            estimatedPayloadLabel={estimatedPayloadLabel}
          />
        ) : null}

        {currentStep === 3 && packagingResult != null ? (
          <CompletionStep result={packagingResult} onDownloadAgain={downloadResultAgain} />
        ) : null}
      </main>

      <footer className="footer">
        <div className="footer__hint">
          저장 경로 선택은 제거되었습니다. 패키징은 브라우저 임시 작업 공간에서 진행한 뒤 완료 즉시 다운로드됩니다.
        </div>
        <div className="footer__actions">
          {currentStep === 1 ? (
            <button className="button button--ghost" type="button" onClick={() => setCurrentStep(0)}>
              Previous Step
            </button>
          ) : null}
          {currentStep === 3 ? (
            <button className="button button--ghost" type="button" onClick={resetWizard}>
              Back to Step 1
            </button>
          ) : null}

          {currentStep === 0 ? (
            <button
              className="button"
              type="button"
              disabled={!isPartnerCodeComplete || isCatalogLoading || isHealthLoading}
              onClick={() => void authorizePartnerCode()}
            >
              {isCatalogLoading ? "Authorizing..." : "Authorize Access"}
            </button>
          ) : null}
          {currentStep === 1 ? (
            <button className="button" type="button" disabled={!canStartPackaging || isPackagingRunning} onClick={() => void startPackaging()}>
              Start Packaging
            </button>
          ) : null}
          {currentStep === 2 ? (
            <button className="button button--danger" type="button" disabled={!isPackagingRunning} onClick={stopPackaging}>
              Stop Packaging
            </button>
          ) : null}
          {currentStep === 3 ? (
            <button className="button" type="button" onClick={startNewPackageFromCurrentAccess}>
              Start New Package
            </button>
          ) : null}
        </div>
      </footer>

      {notices.length > 0 ? (
        <div className="notice-stack">
          {notices.map((notice) => (
            <div key={notice.id} className={`notice notice--${notice.tone}`}>
              <div className="notice__title">{notice.title}</div>
              <div className="notice__message">{notice.message}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PartnerStep(props: {
  partnerCodeInputs: string[];
  partnerCode: string;
  isPartnerCodeComplete: boolean;
  onChange: (index: number, value: string) => void;
  onKeyDown: (index: number, event: React.KeyboardEvent<HTMLInputElement>) => void;
  inputRefs: React.MutableRefObject<Array<HTMLInputElement | null>>;
  isHealthLoading: boolean;
  isCatalogServerChecking: boolean;
  healthError: string | null;
  catalogError: string | null;
  runtimeEngineStatus: string;
  runtimeCatalogStatus: string;
  catalogServerCheckedAt: string | null;
  isCatalogLoading: boolean;
  onProbe: () => Promise<void>;
}) {
  const {
    partnerCodeInputs,
    partnerCode,
    isPartnerCodeComplete,
    onChange,
    onKeyDown,
    inputRefs,
    isHealthLoading,
    isCatalogServerChecking,
    healthError,
    catalogError,
    runtimeEngineStatus,
    runtimeCatalogStatus,
    catalogServerCheckedAt,
    isCatalogLoading,
    onProbe,
  } = props;

  return (
    <section className="gateway">
      <div className="panel panel--hero">
        <div className="eyebrow">SECURE TERMINAL</div>
        <h1 className="hero-title">Partner Access Gateway</h1>
        <p className="hero-copy">5자리 회사 코드를 입력하면 실제 운영 카탈로그를 조회합니다.</p>
        <div className="code-grid">
          {partnerCodeInputs.map((value, index) => (
            <input
              key={index}
              ref={(element) => {
                inputRefs.current[index] = element;
              }}
              className="code-input"
              inputMode="text"
              autoComplete="off"
              maxLength={1}
              value={value}
              onChange={(event) => onChange(index, event.target.value)}
              onKeyDown={(event) => onKeyDown(index, event)}
            />
          ))}
        </div>
        {partnerCode ? (
          <div className={`code-state ${isPartnerCodeComplete ? "is-valid" : "is-pending"}`}>
            입력 코드: {partnerCode.padEnd(5, "•")}
          </div>
        ) : null}
        <div className="runtime-console">
          <div className="runtime-console__head">
            <span>runtime-status.console</span>
            <button className="button button--ghost button--small" type="button" disabled={isHealthLoading || isCatalogServerChecking || isCatalogLoading} onClick={() => void onProbe()}>
              {isCatalogServerChecking ? "Checking" : "Retry Probe"}
            </button>
          </div>
          <div className="runtime-console__line">
            <span className="prompt">$</span>
            <span>boot.runtime --edge-web</span>
            <Badge
              tone={isHealthLoading ? "info" : healthError == null ? "success" : "danger"}
              label={isHealthLoading ? "WAIT" : healthError == null ? "OK" : "ERR"}
            />
          </div>
          <div className="runtime-console__line">
            <span className="prompt">&gt;</span>
            <span>check.catalog --health</span>
            <Badge
              tone={isCatalogServerChecking ? "info" : healthError == null ? "success" : "danger"}
              label={isCatalogServerChecking ? "RUN" : healthError == null ? "LIVE" : "FAIL"}
            />
          </div>
          <RuntimeMeta label="engine" value={runtimeEngineStatus} isDanger={healthError != null} />
          <RuntimeMeta label="catalog" value={runtimeCatalogStatus} isDanger={healthError != null} />
          <RuntimeMeta label="checked_at" value={catalogServerCheckedAt ? timeText(new Date(catalogServerCheckedAt)) : "대기 중"} />
          <RuntimeMeta label="workspace" value="browser temp workspace -> auto download" />
          <RuntimeMeta label="input_mode" value="5-char partner code / backspace rewrite enabled" />
          {catalogError ? <div className="console-error">{catalogError}</div> : null}
        </div>
      </div>
    </section>
  );
}

function ConfigurationStep(props: {
  catalog: CompanyCatalog;
  softwareGroups: SoftwareGroupViewModel[];
  selectedGroup: SoftwareGroupViewModel;
  selectedPackage: RemoteSoftwarePackage;
  selectedDependencyKeys: Set<string>;
  onSelectGroup: (groupId: string) => void;
  onSelectPackage: (packageId: string) => void;
  onToggleDependency: (key: string, checked: boolean) => void;
  onRefreshSizes: () => Promise<void>;
  remoteSizeCache: Record<string, number | null>;
  remoteSizeLoading: Record<string, boolean>;
  estimatedPayloadLabel: string;
  canStartPackaging: boolean;
}) {
  const {
    catalog,
    softwareGroups,
    selectedGroup,
    selectedPackage,
    selectedDependencyKeys,
    onSelectGroup,
    onSelectPackage,
    onToggleDependency,
    onRefreshSizes,
    remoteSizeCache,
    remoteSizeLoading,
    estimatedPayloadLabel,
    canStartPackaging,
  } = props;

  const groupOptions = softwareGroups.map((group) => ({
    value: group.id,
    label: group.name,
  }));
  const packageOptions = selectedGroup.packages.map((item) => ({
    value: item.id,
    label: item.version,
  }));

  return (
    <section className="config-grid">
      <div className="config-grid__main">
        <Panel
          title="Partner Package Configuration"
          subtitle={`${catalog.company.companyName}에 할당된 전체 OS 패키지를 현재 실행 환경과 무관하게 모두 표시합니다.`}
        >
          <div className="form-grid">
            <ComboBox
              label="Software Group"
              value={selectedGroup.id}
              options={groupOptions}
              onChange={onSelectGroup}
            />
            <ComboBox
              label="Version"
              value={selectedPackage.id}
              options={packageOptions}
              onChange={onSelectPackage}
            />
          </div>
          <div className="badge-row">
            <Badge tone="info" label={selectedPackage.os.toUpperCase()} />
            <Badge tone="info" label={selectedPackage.releaseChannel.toUpperCase()} />
            <Badge tone={canStartPackaging ? "success" : "danger"} label={canStartPackaging ? "패키징 가능" : "패키징 차단"} />
          </div>
        </Panel>

        <Panel title="Main Binary" action={<button className="button button--ghost button--small" type="button" onClick={() => void onRefreshSizes()}>Size Refresh</button>}>
          <ArtifactCard binary={selectedPackage.mainBinary} remoteSizeCache={remoteSizeCache} remoteSizeLoading={remoteSizeLoading} />
        </Panel>

        <Panel title="Dependencies">
          {selectedPackage.dependencies.length === 0 ? (
            <div className="empty-text">선택된 의존성이 없습니다.</div>
          ) : (
            <div className="artifact-list">
              {selectedPackage.dependencies.map((dependency) => {
                const key = getDependencyKey(dependency);
                const enabled = selectedDependencyKeys.has(key);
                return (
                  <label key={key} className={`artifact-toggle ${hasUri(dependency) ? "" : "is-disabled"}`}>
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={!hasUri(dependency)}
                      onChange={(event) => onToggleDependency(key, event.target.checked)}
                    />
                    <div className="artifact-toggle__body">
                      <div className="artifact-toggle__title">{getFileName(dependency)}</div>
                      <div className="artifact-toggle__meta">
                        버전 {dependency.version || "-"} · {remoteSizeLabel(dependency, remoteSizeCache, remoteSizeLoading)} ·{" "}
                        {dependency.checksum || "체크섬 미등록"}
                      </div>
                    </div>
                    <div className={`status-dot ${hasUri(dependency) ? "is-success" : "is-danger"}`} />
                  </label>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel title="Install Options">
          <InstallOptionSection title="Desktop Shortcuts" entries={selectedPackage.installOptions.desktopShortcuts} legacyTargets={selectedPackage.installOptions.desktopShortcutTargets} />
          <InstallOptionSection title="Startup Programs" entries={selectedPackage.installOptions.startupPrograms} legacyTargets={selectedPackage.installOptions.startupTargets} />
        </Panel>
      </div>

      <aside className="config-grid__side">
        <Panel title="Packaging Snapshot">
          <SummaryRow label="Partner" value={`${catalog.company.companyName} (${catalog.company.companyCode})`} />
          <SummaryRow label="Product" value={`${selectedPackage.name} ${selectedPackage.version}`} />
          <SummaryRow label="Code Name" value={selectedPackage.codeName} />
          <SummaryRow label="Selected Dependencies" value={`${selectedDependencyKeys.size}/${selectedPackage.dependencies.length}`} />
          <SummaryRow label="Estimated Payload" value={estimatedPayloadLabel} />
          <SummaryRow label="Storage" value="browser temp workspace" />
          <SummaryRow label="Download" value="완료 시 자동 시작" />
          <div className={`message-card ${canStartPackaging ? "is-info" : "is-danger"}`}>
            {canStartPackaging
              ? "Start Packaging을 누르면 선택한 구성으로 패키지 생성을 시작합니다."
              : "메인 파일 또는 의존성 경로가 비어 있어 패키징을 시작할 수 없습니다."}
          </div>
        </Panel>
      </aside>
    </section>
  );
}

function ComboBox(props: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  const { label, value, options, onChange } = props;
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? options[0] ?? null;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent): void {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }
      setIsOpen(false);
    }

    function handleEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  return (
    <div className="field">
      <span>{label}</span>
      <div ref={rootRef} className={`combo ${isOpen ? "is-open" : ""}`}>
        <button
          className="combo__trigger"
          type="button"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((current) => !current)}
        >
          <span className="combo__label">{selectedOption?.label ?? ""}</span>
          <span className="combo__chevron" aria-hidden="true" />
        </button>
        {isOpen ? (
          <div className="combo__menu" role="listbox" aria-label={label}>
            {options.map((option) => (
              <button
                key={option.value}
                className={`combo__option ${option.value === value ? "is-selected" : ""}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PackagingStep(props: {
  progress: number;
  currentTaskLabel: string;
  packagingError: string | null;
  elapsedSeconds: number;
  logs: LogLine[];
  onCopyLogs: () => void;
  processedBytes: number | null;
  totalBytes: number | null;
  bytesPerSecond: number | null;
  dependencySummary: string;
  estimatedPayloadLabel: string;
}) {
  const {
    progress,
    currentTaskLabel,
    packagingError,
    elapsedSeconds,
    logs,
    onCopyLogs,
    processedBytes,
    totalBytes,
    bytesPerSecond,
    dependencySummary,
    estimatedPayloadLabel,
  } = props;

  return (
    <section className="packaging">
      <Panel
        title="Packaging Application"
        subtitle="선택한 구성으로 패키지 파일을 준비하고 저장하는 단계입니다."
      >
        <div className="progress-hero">
          <div>
            <div className="metric-label">Current Task</div>
            <div className="metric-value">{humanizeTask(currentTaskLabel)}</div>
            {packagingError ? <div className="error-text">{packagingError}</div> : null}
          </div>
          <div className="progress-value">{Math.round(progress * 100)}%</div>
        </div>
        <div className="progress-bar">
          <div className="progress-bar__fill" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <div className="badge-row">
          <Badge tone={progress >= 0.9 ? "success" : "info"} label="파일 준비" />
          <Badge tone={progress >= 0.97 ? "success" : "info"} label="내용 확인" />
          <Badge tone={progress >= 1 ? "success" : "info"} label="패키지 정리" />
          <Badge tone="info" label={`진행 시간: ${elapsedSeconds}s`} />
        </div>
      </Panel>

      <div className="packaging__grid">
        <Panel title="진행 정보">
          <SummaryRow label="현재 작업" value={humanizeTask(currentTaskLabel)} />
          <SummaryRow label="진행률" value={`${Math.round(progress * 100)}%`} />
          <SummaryRow label="기록 수" value={`${logs.length}`} />
          <SummaryRow label="선택 항목" value={dependencySummary} />
          <SummaryRow
            label="준비 용량"
            value={
              processedBytes == null
                ? "-"
                : totalBytes != null && totalBytes > 0
                  ? `${formatBytes(processedBytes)} / ${formatBytes(totalBytes)}`
                  : formatBytes(processedBytes)
            }
          />
          <SummaryRow
            label="진행 속도"
            value={bytesPerSecond != null && bytesPerSecond > 0 ? `${formatBytes(Math.round(bytesPerSecond))}/s` : "-"}
          />
          <SummaryRow label="예상 크기" value={estimatedPayloadLabel} />
          <SummaryRow label="저장 방식" value="자동 다운로드" />
        </Panel>

        <Panel title="작업 내역" action={<button className="button button--ghost button--small" type="button" onClick={onCopyLogs} disabled={logs.length === 0}>Copy</button>}>
          <div className="log-console">
            {logs.length === 0 ? (
              <div className="empty-text">패키지 생성을 시작하면 진행 내역이 표시됩니다.</div>
            ) : (
              logs.slice(0, 24).map((log) => (
                <div key={log.id} className="log-line">
                  <span className="log-line__time">[{timeText(log.timestamp)}]</span>
                  <span className={`log-line__level is-${log.level.toLowerCase()}`}>{log.level}</span>
                  <span className="log-line__message">{humanizeLog(log.message)}</span>
                </div>
              ))
            )}
          </div>
        </Panel>
      </div>
    </section>
  );
}

function CompletionStep(props: { result: PackagingResultViewModel; onDownloadAgain: () => void }) {
  const { result, onDownloadAgain } = props;

  return (
    <section className="completion">
      <Panel
        title="Packaging Completed Successfully"
        subtitle="실제 패키지 파일이 생성되었고 브라우저 다운로드가 이미 시작되었습니다."
        action={
          <button className="button" type="button" onClick={onDownloadAgain}>
            Download Again
          </button>
        }
      >
        <div className="completion__grid">
          <div>
            <InfoTile title="File Name" value={result.packageFileName} />
            <InfoTile title="Delivery" value="브라우저 다운로드 / 임시 작업 공간 기반" />
          </div>
          <div>
            <SummaryRow label="Partner" value={`${result.company.companyName} (${result.company.companyCode})`} />
            <SummaryRow label="Software" value={`${result.selectedPackage.name} ${result.selectedPackage.version}`} />
            <SummaryRow label="OS" value={result.selectedPackage.os} />
            <SummaryRow label="Release Channel" value={result.selectedPackage.releaseChannel} />
            <SummaryRow label="Dependency Count" value={`${result.dependencyArtifacts.length}`} />
            <SummaryRow label="Package Size" value={formatBytes(result.packageSizeBytes)} />
            <SummaryRow label="Generated At" value={formatDateTime(result.generatedAt)} />
          </div>
        </div>
      </Panel>

      <div className="completion__grid">
        <Panel title="Checksum Verified">
          <div className="message-card is-success">
            메인 바이너리와 선택된 의존성의 xxHash64 검증을 모두 통과했습니다.
          </div>
          <SummaryRow label="Main Artifact" value={result.mainArtifact.fileName} />
          <SummaryRow label="Main Checksum" value={result.mainArtifact.checksum} />
        </Panel>

        <Panel title="Included Dependencies">
          {result.dependencyArtifacts.length === 0 ? (
            <div className="empty-text">포함된 의존성이 없습니다.</div>
          ) : (
            result.dependencyArtifacts.map((artifact) => (
              <SummaryRow key={artifact.archivePath} label={artifact.fileName} value={formatBytes(artifact.sizeBytes)} />
            ))
          )}
        </Panel>
      </div>
    </section>
  );
}

function Panel(props: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { title, subtitle, action, children } = props;
  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2 className="panel__title">{title}</h2>
          {subtitle ? <p className="panel__subtitle">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      <div className="panel__body">{children}</div>
    </section>
  );
}

function ArtifactCard(props: {
  binary: RemoteSoftwareBinary;
  remoteSizeCache: Record<string, number | null>;
  remoteSizeLoading: Record<string, boolean>;
}) {
  const { binary, remoteSizeCache, remoteSizeLoading } = props;
  return (
    <div className="artifact-card">
      <div>
        <div className="artifact-card__title">{getFileName(binary)}</div>
        <div className="artifact-card__meta">
          버전 {binary.version || "-"} · {remoteSizeLabel(binary, remoteSizeCache, remoteSizeLoading)} ·{" "}
          {binary.checksum || "체크섬 미등록"}
        </div>
      </div>
      <div className={`status-dot ${hasUri(binary) ? "is-success" : "is-danger"}`} />
    </div>
  );
}

function InstallOptionSection(props: {
  title: string;
  entries: RemoteInstallEntry[];
  legacyTargets: string[];
}) {
  const { title, entries, legacyTargets } = props;
  const hasEntries = entries.length > 0 || legacyTargets.length > 0;
  return (
    <div className="install-section">
      <div className="install-section__title">{title}</div>
      {!hasEntries ? <div className="empty-text">설정된 항목이 없습니다.</div> : null}
      {entries.map((entry) => (
        <div key={`${entry.target}-${entry.name}`} className="install-tile">
          <div className="install-tile__name">{entry.name || entry.target || "Unnamed Entry"}</div>
          {entry.target ? <div className="install-tile__target">{entry.target}</div> : null}
        </div>
      ))}
      {legacyTargets.map((target) => (
        <div key={target} className="install-tile">
          <div className="install-tile__name">{target}</div>
          <div className="install-tile__target">{target}</div>
        </div>
      ))}
    </div>
  );
}

function HeaderMeta(props: { label: string; value: string }) {
  return (
    <div className="header-meta">
      <span className="header-meta__label">{props.label}</span>
      <span className="header-meta__value">{props.value}</span>
    </div>
  );
}

function Badge(props: { label: string; tone: "info" | "success" | "warning" | "danger" }) {
  return <span className={`badge badge--${props.tone}`}>{props.label}</span>;
}

function RuntimeMeta(props: { label: string; value: string; isDanger?: boolean }) {
  return (
    <div className="runtime-meta">
      <span>{props.label}</span>
      <span className={props.isDanger ? "is-danger" : ""}>{props.value}</span>
    </div>
  );
}

async function requestJson(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    requestErrorMessage?: string;
    invalidJsonMessage?: string;
  } = {},
): Promise<Record<string, unknown>> {
  const {
    method = "GET",
    body,
    signal,
    requestErrorMessage,
    invalidJsonMessage = "서버 응답을 처리하지 못했습니다.",
  } = options;
  const headers: Record<string, string> = {};
  if (body != null) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(buildApiUrl(path), {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal,
  });

  const text = await response.text();
  const parsed = parseJsonObject(text);

  if (!response.ok) {
    let message = requestErrorMessage ?? `요청 실패 (${response.status})`;
    message =
      (typeof parsed?.message === "string" && parsed.message) ||
      (typeof parsed?.error === "string" && parsed.error) ||
      text.trim() ||
      message;
    console.error("[SoftEgg] API request failed", {
      path,
      method,
      status: response.status,
      responseText: text.slice(0, 1000),
      parsed,
    });
    throw new Error(message);
  }

  if (response.status === 204) {
    return {};
  }

  if (parsed == null) {
    console.error("[SoftEgg] API response was not valid JSON object", {
      path,
      method,
      status: response.status,
      responseText: text.slice(0, 1000),
    });
    throw new Error(invalidJsonMessage);
  }

  return parsed;
}

async function probeCatalogServerRequest(): Promise<void> {
  const response = await fetch(buildApiUrl("/api/health"), {
    method: "GET",
    headers: {
      accept: "application/json",
    },
    cache: "no-store",
  });

  if (response.ok) {
    const text = await response.text().catch(() => "");
    if (text.trim()) {
      console.debug("[SoftEgg] Health response", {
        status: response.status,
        responseText: text.slice(0, 400),
      });
    }
    return;
  }

  console.error("[SoftEgg] Health request failed", {
    status: response.status,
  });
  throw new Error(
    await readApiErrorMessage(response, "카탈로그 서버 상태 확인에 실패했습니다."),
  );
}

async function fetchCatalogRequest(companyCode: string): Promise<CompanyCatalog> {
  const normalizedCode = companyCode.trim().toUpperCase();
  const response = await fetch(buildApiUrl(`/api/public/software-catalog/${normalizedCode}`), {
    method: "GET",
    headers: {
      accept: "application/json",
    },
    cache: "no-store",
  });

  const text = await response.text();
  const payload = parseJsonObject(text);

  if (!response.ok) {
    console.error("[SoftEgg] Catalog request failed", {
      companyCode: normalizedCode,
      status: response.status,
      responseText: text.slice(0, 1000),
      payload,
    });
    throw new Error(
      (typeof payload?.message === "string" && payload.message) ||
        "카탈로그 조회에 실패했습니다.",
    );
  }

  if (payload == null) {
    console.error("[SoftEgg] Catalog response was not valid JSON object", {
      companyCode: normalizedCode,
      status: response.status,
      responseText: text.slice(0, 1000),
    });
    throw new Error("카탈로그 응답 형식이 올바르지 않습니다.");
  }

  return parseCompanyCatalog(payload);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text.trim()) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readApiErrorMessage(response: Response, fallbackMessage: string): Promise<string> {
  const text = await response.text().catch(() => "");
  const parsed = parseJsonObject(text);
  return (
    (typeof parsed?.message === "string" && parsed.message) ||
    (typeof parsed?.error === "string" && parsed.error) ||
    text.trim() ||
    fallbackMessage
  );
}

function logClientError(message: string, error: unknown, context?: Record<string, unknown>): void {
  console.error(`[SoftEgg] ${message}`, {
    error,
    ...(context ? { context } : {}),
  });
}

function toHealthUiMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : "";
  if (
    isSafeUiMessage(rawMessage, [
      "카탈로그 서버 상태 확인에 실패했습니다.",
      "카탈로그 서버 응답을 처리하지 못했습니다.",
      "카탈로그 서버 상태 응답이 JSON 형식이 아닙니다.",
      "카탈로그 서버 상태 응답 형식이 올바르지 않습니다.",
    ])
  ) {
    return rawMessage;
  }
  return "서비스 연결 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

function toCatalogUiMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : "";
  if (
    isSafeUiMessage(rawMessage, [
      "회사 코드를 입력해 주세요.",
      "회사 코드가 만료되었거나 일치하지 않습니다.",
      "회사 코드가 중복되어 확인할 수 없습니다. 관리자에게 문의해 주세요.",
      "카탈로그 서버 응답을 처리하지 못했습니다.",
      "카탈로그 응답 형식이 올바르지 않습니다.",
      "표시 가능한 소프트웨어가 없습니다.",
      "할당된 소프트웨어가 없습니다.",
      "카탈로그 조회에 실패했습니다.",
    ])
  ) {
    return rawMessage;
  }
  return "카탈로그 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

function toPackagingUiMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : "";
  if (rawMessage === "작업이 중단되었습니다.") {
    return rawMessage;
  }
  if (rawMessage.includes("체크섬 검증에 실패했습니다")) {
    return "다운로드한 파일 검증에 실패했습니다. 다시 시도해 주세요.";
  }
  if (
    isSafeUiMessage(rawMessage, [
      "패키징 중 예기치 않은 오류가 발생했습니다.",
      "패키징에 실패했습니다.",
    ])
  ) {
    return rawMessage;
  }
  return "패키징 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
}

function isSafeUiMessage(rawMessage: string, allowList: string[]): boolean {
  const message = rawMessage.trim();
  if (!message) {
    return false;
  }
  if (allowList.includes(message)) {
    return true;
  }
  return !/(https?:\/\/|ftp:\/\/|licensehub|api|endpoint|uri|url|ftp|socket|softegg_|wrangler|cloudflare)/i.test(
    message,
  );
}

function normalizeCompanyCodeInput(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function SummaryRow(props: { label: string; value: string }) {
  return (
    <div className="summary-row">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function InfoTile(props: { title: string; value: string }) {
  return (
    <div className="info-tile">
      <div className="info-tile__title">{props.title}</div>
      <div className="info-tile__value">{props.value}</div>
    </div>
  );
}

function remoteSizeLabel(
  binary: RemoteSoftwareBinary,
  cache: Record<string, number | null>,
  loading: Record<string, boolean>,
): string {
  if (!hasUri(binary)) {
    return "미등록";
  }
  const uri = binary.uri.trim();
  if (loading[uri]) {
    return "조회 중";
  }
  if (cache[uri] == null) {
    return cache[uri] === null ? "미확인" : "대기 중";
  }
  return formatBytes(cache[uri]);
}

function buildArtifactSlices(
  binaries: RemoteSoftwareBinary[],
  artifactSizes: Record<string, number | null>,
  phaseStart: number,
  phaseEnd: number,
  minimumSliceSpan: number,
): Record<string, [number, number]> {
  const slices: Record<string, [number, number]> = {};
  const phaseSpan = phaseEnd - phaseStart;
  const fallbackWeight = 1 / binaries.length;
  const totalKnownSize = binaries.reduce((sum, binary) => sum + (artifactSizes[binary.uri.trim()] ?? 0), 0);
  const reservedMinimum = minimumSliceSpan * binaries.length;
  const distributableSpan = reservedMinimum >= phaseSpan ? 0 : phaseSpan - reservedMinimum;
  let cursor = phaseStart;

  binaries.forEach((binary, index) => {
    const size = artifactSizes[binary.uri.trim()];
    const weight = totalKnownSize > 0 && size != null && size > 0 ? size / totalKnownSize : fallbackWeight;
    const start = cursor;
    const end = index === binaries.length - 1 ? phaseEnd : cursor + minimumSliceSpan + distributableSpan * weight;
    slices[binary.uri.trim()] = [start, end];
    cursor = end;
  });

  return slices;
}

function concatenateUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function makeSafeArchiveFileName(fileName: string, usedFileNames: Set<string>): string {
  const normalized = sanitizeSegment(fileName || "artifact.bin");
  const match = normalized.match(/^(.*?)(\.[^.]+)?$/);
  const baseName = match?.[1] || "artifact";
  const extension = match?.[2] || "";
  let candidate = `${baseName}${extension}`;
  let index = 2;
  while (usedFileNames.has(candidate)) {
    candidate = `${baseName}-${index}${extension}`;
    index += 1;
  }
  usedFileNames.add(candidate);
  return candidate;
}

function timeText(value: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
}

function buildApiUrl(path: string): string {
  return new URL(path, API_BASE_URL).toString();
}

function resolveApiBaseUrl(rawValue: string | undefined): string {
  const fallbackOrigin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const normalized = rawValue?.trim() || fallbackOrigin;

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    console.error("[SoftEgg] Invalid VITE_API_BASE_URL, fallback to current origin", {
      rawValue,
      fallbackOrigin,
    });
    return fallbackOrigin;
  }
}
