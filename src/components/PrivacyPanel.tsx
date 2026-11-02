export function PrivacyPanel() {
  return (
    <details className="card p-4 sm:p-5 text-sm group">
      <summary className="cursor-pointer font-semibold text-[--color-brand2] list-none flex items-center gap-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        What ProShare does with your data - the honest version
      </summary>
      <ul className="mt-3 space-y-2 text-[--color-mut] leading-relaxed list-disc pl-5">
        <li><b className="text-white">Files and text never touch a server.</b> They travel directly between the two browsers over an encrypted WebRTC channel. There is nothing to breach on our side because nothing is stored on our side.</li>
        <li><b className="text-white">The code is an address, not a key.</b> Anyone who knows a live room code can request to join - the sender approves each person explicitly, and nothing transfers without approval. Codes are never used as encryption keys (a 6-digit code would be guessable). Each connection creates its own fresh encryption keys.</li>
        <li><b className="text-white">Finding each other needs a public bulletin board.</b> To connect the two browsers, ProShare posts connection details to public Nostr relays. Those relays - and anyone who guesses a live code - can see connection metadata (IP addresses, timing), never file contents. Relay log retention is outside our control.</li>
        <li><b className="text-white">Compare the 6-digit verification code.</b> It is created fresh for each connection from keys only your two devices hold. If a third party wedged itself between you, the codes would not match - compare them over a call or another chat.</li>
        <li><b className="text-white">No analytics, no trackers, no ads, no accounts.</b> This site loads no third-party scripts and sets no cookies.</li>
        <li><b className="text-white">Limits, honestly:</b> files are held in memory while transferring, so very large files can strain weak devices. Connections can fail on some restrictive corporate or mobile networks because there is no relay fallback by design. Closing either tab ends the session.</li>
      </ul>
    </details>
  )
}
