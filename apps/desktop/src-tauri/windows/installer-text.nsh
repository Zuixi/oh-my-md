; oh-my-md installer welcome/finish copy (en + zh).
; Included via bundle.windows.nsis.installerHooks before MUI pages are inserted.

LangString OMD_WELCOME_TITLE ${LANG_ENGLISH} "Welcome to oh-my-md Setup"
LangString OMD_WELCOME_TITLE ${LANG_SIMPCHINESE} "欢迎使用 oh-my-md 安装向导"

LangString OMD_WELCOME_TEXT ${LANG_ENGLISH} "This will install oh-my-md on your computer.$\r$\n$\r$\nClick Next to continue, or Cancel to exit."
LangString OMD_WELCOME_TEXT ${LANG_SIMPCHINESE} "欢迎使用 oh-my-md 安装向导。$\r$\n点击「下一步」开始安装，或点击「取消」退出。"

!define MUI_WELCOMEPAGE_TITLE "$(OMD_WELCOME_TITLE)"
!define MUI_WELCOMEPAGE_TEXT "$(OMD_WELCOME_TEXT)"

LangString OMD_FINISH_TITLE ${LANG_ENGLISH} "Completing oh-my-md Setup"
LangString OMD_FINISH_TITLE ${LANG_SIMPCHINESE} "完成 oh-my-md 安装"

LangString OMD_FINISH_TEXT ${LANG_ENGLISH} "oh-my-md has been installed on your computer.$\r$\n$\r$\nClick Finish to close this wizard."
LangString OMD_FINISH_TEXT ${LANG_SIMPCHINESE} "oh-my-md 已安装完成。$\r$\n$\r$\n点击「完成」关闭安装向导。"

!define MUI_FINISHPAGE_TITLE "$(OMD_FINISH_TITLE)"
!define MUI_FINISHPAGE_TEXT "$(OMD_FINISH_TEXT)"
