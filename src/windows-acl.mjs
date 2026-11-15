// 描述符来自 icacls /save 的原生输出，不是调用方自报的身份。
export function currentWindowsTrustee(descriptor) {
  // 探针目录只授予 whoami 的精确 SID 且关闭继承；仅当只有一条显式 ACE 时才采信其序列化身份。
  return /^D:[A-Z]*\(A;OICI;FA;;;([A-Z]{2}|S-1-[0-9-]+)\)$/.exec(descriptor)?.[1];
}

export function isPrivateWindowsAcl(descriptor, currentTrustee) {
  if (!currentTrustee || !/^D:[A-Z]*(?:\([^()]*\))+$/.test(descriptor)) return false;
  const allowed = new Set([currentTrustee, "BA", "SY", "S-1-5-18", "S-1-5-32-544"]);
  let currentUserAllowed = false;
  for (const match of descriptor.matchAll(/\(([^()]*)\)/g)) {
    const parts = match[1].split(";");
    if (parts.length !== 6) return false;
    const [type, flags, rights, object, inherited, identity] = parts;
    if (type === "D") continue;
    if (type !== "A" || object || inherited || !allowed.has(identity)) return false;
    if (identity === currentTrustee && rights === "FA" && !flags.includes("IO")) currentUserAllowed = true;
  }
  return currentUserAllowed;
}
