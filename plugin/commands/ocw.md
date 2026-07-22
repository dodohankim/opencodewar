---
description: Open Code War — 프로필(닉네임·bio·직함·회사·링크·프로젝트) 설정, 내 순위/상태 확인
argument-hint: "help | nickname <이름> | bio <소개> | role <직함> | company <회사> | city <도시> | link <종류> <url> | project add|list|remove|clear | status | delete"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

아래는 Open Code War CLI의 실행 결과입니다. 추가 작업 없이 사용자에게 그대로 전달하세요.

<!-- $ARGUMENTS 를 따옴표로 감싸 URL(?, &, #)·공백·다국어 인자가 셸에서 분해되지 않게 한다.
     CLI 는 이를 하나의 문자열로 받아 직접 파싱한다(따옴표 유무 모두 허용). -->

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/ocw-cli.mjs "$ARGUMENTS"`
