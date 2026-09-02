Output docs/assets/workflow-demo/.build/workflow-tui-raw.mp4

Require pi

Set Shell "bash"
Set Width 1280
Set Height 720
Set FontSize 19
Set FontFamily "Menlo"
Set LetterSpacing 0
Set LineHeight 1.1
Set Framerate 20
Set Padding 24
Set Margin 0
Set BorderRadius 12
Set WindowBar Rings
Set WindowBarSize 34
Set TypingSpeed 34ms
Set Theme { "name": "Rattle", "black": "#0B1116", "red": "#DF6B73", "green": "#4FB7A7", "yellow": "#D6A45F", "blue": "#478BC7", "magenta": "#9B8EE8", "cyan": "#62B8D6", "white": "#DCE7EC", "brightBlack": "#536570", "brightRed": "#DF6B73", "brightGreen": "#78BEAE", "brightYellow": "#D6A45F", "brightBlue": "#6D8FE8", "brightMagenta": "#B6A8E8", "brightCyan": "#8FCBDD", "brightWhite": "#FFFFFF", "background": "#0B1116", "foreground": "#DCE7EC", "selection": "#172A33", "cursor": "#62B8D6" }

Hide
Type "PI_CODING_AGENT_DIR=/tmp/pibox-workflow-demo-agent pi --offline --tui-mode fullscreen --no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --theme themes/rattle.json --use-theme rattle --extension docs/assets/workflow-demo/capture.ts"
Enter
Sleep 2200ms
Show
Sleep 700ms
Type "Let's make a todo list app."
Sleep 500ms
Enter
Sleep 13500ms
Hide
Ctrl+C
Sleep 500ms
