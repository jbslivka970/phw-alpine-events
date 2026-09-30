function redirectAfterLocalLogout(): void {
  window.location.replace('/login?logout=local')
}

export { redirectAfterLocalLogout }