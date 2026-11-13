/** Keep keyboard traversal inside an open modal, including the browser-chrome boundary. */
export function homeDialogKey(event: KeyboardEvent) {
    const dialog = event.currentTarget as HTMLDialogElement
    if (event.key !== 'Tab' || !dialog.open) return
    const controls = [...dialog.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,summary,[tabindex]')]
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length && !element.closest('[inert]'))
    const first = controls[0], last = controls.at(-1)
    if (!first || !last) { event.preventDefault(); dialog.focus(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { event.preventDefault(); first.focus() }
}
