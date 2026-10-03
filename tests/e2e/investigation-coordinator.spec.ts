import {test,expect,type Browser,type Page,type TestInfo} from "@playwright/test";import {installAuthArtifactPolicy} from "../helpers/auth-browser-artifact-policy.js";
installAuthArtifactPolicy(test);
function check(v:unknown):asserts v{if(!v)throw new Error("Owned workflow browser assertion failed");}
async function broker<T>(action:string,body:unknown):Promise<T>{const endpoint=process.env.LOCAL_WORKFLOW_FIXTURE_URL,token=process.env.LOCAL_WORKFLOW_FIXTURE_TOKEN;check(endpoint&&token&&new URL(endpoint).hostname==="127.0.0.1");const r=await fetch(`${endpoint}/${action}`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify(body)});check(r.ok);return r.json() as Promise<T>;}
async function context(browser:Browser,info:TestInfo){return browser.newContext({baseURL:process.env.APP_ORIGIN,viewport:info.project.use.viewport,isMobile:info.project.use.isMobile,hasTouch:info.project.use.hasTouch});}
async function login(page:Page,person:{id:string;email:string}){await page.goto("/login");await page.getByLabel("이메일",{exact:true}).fill(person.email);await page.getByRole("button",{name:"코드 받기",exact:true}).click();await expect(page.getByLabel("로그인 코드",{exact:true})).toBeVisible();const {code}=await broker<{code:string}>("code",{id:person.id});await page.getByLabel("로그인 코드",{exact:true}).fill(code);await page.getByRole("button",{name:"로그인",exact:true}).click();await expect(page.getByRole("heading",{name:"내 조사방",exact:true})).toBeVisible();}
function sceneName(info:TestInfo,kind:"history"|"control"){return `${info.project.name.includes("mobile")?"mobile":"desktop"}-${kind}`;}
test("should display an owned investigation and restore public history for an observer",async({browser},info)=>{const a=await context(browser,info),b=await context(browser,info);try{const scene=sceneName(info,"history");const data=await broker<{roomId:string;owner:{id:string;email:string};observer:{id:string;email:string}}>("setup",{scene});const ap=await a.newPage(),bp=await b.newPage();await login(ap,data.owner);await login(bp,data.observer);await ap.goto(`/app/rooms/${data.roomId}`);await bp.goto(`/app/rooms/${data.roomId}`);const own=ap.getByRole("region",{name:"실제 공동 조사"}),observed=bp.getByRole("region",{name:"실제 공동 조사"});await expect(own.getByRole("button",{name:"공동 발언 저장",exact:true})).toBeVisible();await expect(observed.getByRole("button",{name:"공동 발언 저장",exact:true})).toHaveCount(0);await own.getByLabel("공동 발언",{exact:true}).fill("브라우저 공개 발언");await own.getByRole("button",{name:"공동 발언 저장",exact:true}).click();await expect(own.getByLabel("확정 공동 이력")).toContainText("브라우저 공개 발언");await broker("drive",{scene,step:"history"});await expect(observed.getByLabel("확정 공동 이력")).toContainText("합성 공개 질문",{timeout:45000});await expect(observed.getByLabel("확정 공동 이력")).toContainText("합성 공개 결과");await expect(observed.getByLabel("확정 공동 이력")).toContainText("합성 공개 origin 결과");await expect(observed.getByLabel("확정 공동 이력")).toContainText("합성 공개 최종 결과");await bp.reload();await expect(observed.getByLabel("확정 공동 이력")).toContainText("브라우저 공개 발언");await expect(observed.getByText("현재 조사 채택",{exact:true}).first()).toBeVisible();check(!((await bp.content()).includes("private-native-")||(await bp.content()).includes("credentialHash")));check(await bp.locator("body").evaluate(el=>el.scrollWidth<=innerWidth+1));}finally{await Promise.all([a.close(),b.close()]);}});
test("should distinguish reported execution unknown and confirmed pause in the browser",async({browser},info)=>{const a=await context(browser,info);try{const scene=sceneName(info,"control");const data=await broker<{roomId:string;owner:{id:string;email:string}}>("setup",{scene});const page=await a.newPage();await login(page,data.owner);await page.goto(`/app/rooms/${data.roomId}`);const region=page.getByRole("region",{name:"실제 공동 조사"});await expect(region).toContainText("실제 provider 검증은 아직 없습니다");await broker("drive",{scene,step:"start"});await expect(region.getByLabel("공개 실행 보고")).toContainText("실행 보고 · provider 미검증",{timeout:45000});const pause=region.getByRole("button",{name:"방 일시정지 요청",exact:true});await pause.focus();await page.keyboard.press("Enter");await expect(region.getByRole("status")).toContainText("중단 확인 대기");await broker("drive",{scene,step:"ack"});await expect(region.getByRole("status")).toContainText("중단 확인 대기");await broker("drive",{scene,step:"unknown"});await expect(region.getByLabel("공개 실행 보고")).toContainText("종결 미확인 · 사람 확인 필요",{timeout:45000});const resume=region.getByRole("button",{name:"방 발언·조사 접수 재개",exact:true});await expect(resume).toBeDisabled();await broker("drive",{scene,step:"terminal"});await expect(region.getByRole("status")).toContainText("일시정지 확인",{timeout:45000});await expect(resume).toBeEnabled();await resume.focus();await page.keyboard.press("Enter");await expect(region.getByRole("status")).toContainText("활성");await region.getByLabel("공동 발언",{exact:true}).fill(" ");await region.getByRole("button",{name:"공동 발언 저장",exact:true}).click();const error=region.getByRole("alert",{name:"조사 오류",exact:true});await expect(error).toBeVisible();await expect(error).toBeFocused();check(!(await page.content()).includes("private-native-"));check(await page.locator("body").evaluate(el=>el.scrollWidth<=innerWidth+1));}finally{await a.close();}});

test("should show a direct question form without an own AI connection", async ({ browser }, info) => {
  // Idle/hidden polling takes 10/30 seconds; wait up to 45 seconds for external changes.
  const pollingWait = { timeout: 45_000 };
  for (const variant of ["single", "multiple"]) {
    // Emit literal stages only; never include identity, DOM, request or error values.
    if (variant === "single") process.stdout.write("010_DIRECT_STAGE SINGLE_BEGIN\n");
    else process.stdout.write("010_DIRECT_STAGE MULTIPLE_BEGIN\n");
    const own = await context(browser, info), observed = await context(browser, info);
    try {
      const scene = `${info.project.name.includes("mobile") ? "mobile" : "desktop"}-direct-${variant}`;
      process.stdout.write("010_DIRECT_STAGE SETUP_BEFORE\n");
      const data = await broker<{ roomId: string; targetAgentIds: string[];
        requester: { id: string; email: string }; observer: { id: string; email: string } }>("setup", { scene });
      process.stdout.write("010_DIRECT_STAGE SETUP_AFTER\n");
      const page = await own.newPage(), observer = await observed.newPage();
      process.stdout.write("010_DIRECT_STAGE REQUESTER_LOGIN_BEFORE\n");
      await login(page, data.requester);
      process.stdout.write("010_DIRECT_STAGE OBSERVER_LOGIN_BEFORE\n");
      await login(observer, data.observer);
      process.stdout.write("010_DIRECT_STAGE READY_BEFORE\n");
      await broker("direct-drive", { scene, step: "ready" });
      process.stdout.write("010_DIRECT_STAGE READY_AFTER\n");
      await page.goto(`/app/rooms/${data.roomId}`);
      await observer.goto(`/app/rooms/${data.roomId}`);
      process.stdout.write("010_DIRECT_STAGE ROOM_LOADED\n");
      const region = page.getByRole("region", { name: "실제 공동 조사" });
      const form = region.getByRole("form", { name: "상대 AI에 직접 질문" });
      const target = form.getByLabel("직접 질문 대상", { exact: true });
      const send = form.getByRole("button", { name: "상대 AI에 질문 보내기", exact: true });
      process.stdout.write("010_DIRECT_STAGE FORM_VISIBLE_BEFORE\n");
      await expect(form).toBeVisible();
      process.stdout.write("010_DIRECT_STAGE OBSERVER_READ_ONLY_BEFORE\n");
      await expect(observer.getByRole("form", { name: "상대 AI에 직접 질문" })).toHaveCount(0);
      process.stdout.write("010_DIRECT_STAGE OWN_AI_DISABLED_BEFORE\n");
      await expect(region.getByRole("button", { name: "조사 시작", exact: true })).toBeDisabled();
      if (variant === "single") {
        process.stdout.write("010_DIRECT_STAGE SINGLE_TARGET_BEFORE\n");
        await expect(target).toHaveValue(data.targetAgentIds[0]);
        process.stdout.write("010_DIRECT_STAGE SINGLE_TARGET_AFTER\n");
        await expect(form).toContainText("codex");
        process.stdout.write("010_DIRECT_STAGE SINGLE_DESCRIPTION_AFTER\n");
      } else {
        process.stdout.write("010_DIRECT_STAGE MULTIPLE_SELECTION_BEFORE\n");
        await expect(target).toHaveValue("");
        await expect(send).toBeDisabled();
        await target.selectOption(data.targetAgentIds[0]);
        process.stdout.write("010_DIRECT_STAGE REPLACE_BEFORE\n");
        await broker("direct-drive", { scene, step: "replace" });
        process.stdout.write("010_DIRECT_STAGE REPLACE_DISABLED_BEFORE\n");
        await expect(send).toBeDisabled(pollingWait);
        await expect(target).toContainText("기존 대상 변경", pollingWait);
        process.stdout.write("010_DIRECT_STAGE REPLACE_RESELECT_BEFORE\n");
        await target.selectOption(data.targetAgentIds[0]);
        await expect(form).toContainText("새 직접 세션", pollingWait);
        process.stdout.write("010_DIRECT_STAGE OFFLINE_BEFORE\n");
        await broker("direct-drive", { scene, step: "offline" });
        await expect(send).toBeDisabled(pollingWait);
        await target.selectOption(data.targetAgentIds[1]);
        process.stdout.write("010_DIRECT_STAGE MULTIPLE_SELECTION_AFTER\n");
      }
      process.stdout.write("010_DIRECT_STAGE FORM_INPUT_BEFORE\n");
      await form.getByLabel("상대에게 보낼 질문", { exact: true }).fill("한국어 키보드 직접 질문 😀");
      await form.getByRole("checkbox").check();
      await expect(send).toBeEnabled();
      process.stdout.write("010_DIRECT_STAGE FORM_READY\n");
      const bodies: unknown[] = [];
      if (variant === "single") {
        let lost = false;
        await page.route("**/api/investigations/ask", async route => {
          bodies.push(route.request().postDataJSON());
          const response = await route.fetch();
          if (!lost) { lost = true; await route.abort("failed"); }
          else await route.fulfill({ response });
        });
      }
      process.stdout.write("010_DIRECT_STAGE SEND_BEFORE\n");
      await send.focus();
      await page.keyboard.press("Enter");
      process.stdout.write("010_DIRECT_STAGE QUESTION_HISTORY_BEFORE\n");
      await expect(region.getByLabel("확정 공동 이력")).toContainText("한국어 키보드 직접 질문 😀", { timeout: 45000 });
      process.stdout.write("010_DIRECT_STAGE QUESTION_HISTORY_AFTER\n");
      if (variant === "single") {
        process.stdout.write("010_DIRECT_STAGE RECOVERY_VISIBLE_BEFORE\n");
        await expect(region.getByRole("button", { name: "같은 요청 확인", exact: true })).toBeVisible();
        await page.reload();
        process.stdout.write("010_DIRECT_STAGE RECOVERY_REPLAY_BEFORE\n");
        await region.getByRole("button", { name: "같은 요청 확인", exact: true }).click();
        await expect(region.getByRole("button", { name: "같은 요청 확인", exact: true })).toHaveCount(0);
        check(bodies.length === 2 && JSON.stringify(bodies[0]) === JSON.stringify(bodies[1]));
        process.stdout.write("010_DIRECT_STAGE RECOVERY_REPLAY_AFTER\n");
        const result = await broker<{ requests: number }>("direct-drive", { scene, step: "answer" });
        check(result.requests === 1);
        process.stdout.write("010_DIRECT_STAGE ANSWER_REQUESTER_BEFORE\n");
        await expect(region.getByLabel("확정 공동 이력")).toContainText("한글 직접 답변", pollingWait);
        process.stdout.write("010_DIRECT_STAGE ANSWER_OBSERVER_BEFORE\n");
        await expect(observer.getByLabel("확정 공동 이력")).toContainText("한글 직접 답변", pollingWait);
        await page.reload();
        process.stdout.write("010_DIRECT_STAGE ANSWER_RELOAD_BEFORE\n");
        await expect(region.getByLabel("직접 질문 상태")).toContainText("완료 보고", pollingWait);
        await expect(region.getByRole("button", { name: "이 직접 질문 중단 요청", exact: true })).toHaveCount(0);
        process.stdout.write("010_DIRECT_STAGE ANSWER_AFTER\n");
      } else {
        process.stdout.write("010_DIRECT_STAGE ACTIVE_START_BEFORE\n");
        await broker("direct-drive", { scene, step: "start" });
        await expect(region.getByLabel("직접 질문 상태")).toContainText("실행 보고", { timeout: 45000 });
        process.stdout.write("010_DIRECT_STAGE CANCEL_BEFORE\n");
        const stop = region.getByRole("button", { name: "이 직접 질문 중단 요청", exact: true });
        await stop.focus();
        await page.keyboard.press("Enter");
        await expect(region.getByRole("status").filter({ hasText: "조사: 사람 확인 필요" })).toBeVisible(pollingWait);
        process.stdout.write("010_DIRECT_STAGE CANCEL_ACK_BEFORE\n");
        await broker("direct-drive", { scene, step: "ack" });
        await expect(region.getByLabel("직접 질문 상태")).toContainText("실행 보고", pollingWait);
        await expect(send).toBeDisabled(pollingWait);
        process.stdout.write("010_DIRECT_STAGE CANCEL_TERMINAL_BEFORE\n");
        await broker("direct-drive", { scene, step: "terminal" });
        await expect(region.getByLabel("직접 질문 상태")).toContainText("중단 확인 보고", pollingWait);
        process.stdout.write("010_DIRECT_STAGE CANCEL_AFTER\n");
      }
      process.stdout.write("010_DIRECT_STAGE PRIVACY_LAYOUT_BEFORE\n");
      check(!(await page.content()).includes("private-native-"));
      check(await page.locator("body").evaluate(element => element.scrollWidth <= innerWidth + 1));
      process.stdout.write("010_DIRECT_STAGE VARIANT_AFTER\n");
    } finally {
      process.stdout.write("010_DIRECT_STAGE CLEANUP_BEFORE\n");
      await Promise.all([own.close(), observed.close()]);
      process.stdout.write("010_DIRECT_STAGE CLEANUP_AFTER\n");
    }
  }
});

test("should isolate unresolved direct intents across authenticated users", async ({ browser }, info) => {
  for (const mode of ["actor", "cookie"] as const) {
    const owned = await context(browser, info);
    try {
      const scene = `${info.project.name.includes("mobile") ? "mobile" : "desktop"}-direct-${mode}`;
      const data = await broker<{ roomId: string; requester: { id: string; email: string };
        actorB: { id: string; email: string } }>("setup", { scene });
      const page = await owned.newPage();
      await login(page, data.requester);
      await broker("direct-drive", { scene, step: "ready" });
      await page.goto(`/app/rooms/${data.roomId}`);
      let first = true;
      let staleStatus = 0;
      let transmissions = 0;
      await page.route("**/api/investigations/ask", async route => {
        transmissions++;
        const response = await route.fetch();
        if (first) { first = false; await route.abort("failed"); }
        else { staleStatus = response.status(); await route.fulfill({ response }); }
      });
      const region = page.getByRole("region", { name: "실제 공동 조사" });
      const form = region.getByRole("form", { name: "상대 AI에 직접 질문" });
      await form.getByLabel("상대에게 보낼 질문", { exact: true }).fill("계정 전환의 확정된 첫 질문");
      await form.getByRole("checkbox").check();
      await form.getByRole("button", { name: "상대 AI에 질문 보내기", exact: true }).click();
      await expect(region.getByRole("button", { name: "같은 요청 확인", exact: true })).toBeVisible();
      await broker("direct-drive", { scene, step: "answer" });
      await expect(region.getByLabel("직접 질문 상태")).toContainText("완료 보고", { timeout: 45_000 });
      if (mode === "actor") {
        await page.getByRole("button", { name: "로그아웃", exact: true }).click();
        await expect(page.getByRole("heading", { name: "조사실 로그인", exact: true })).toBeVisible();
        await login(page, data.actorB);
        await page.goto(`/app/rooms/${data.roomId}`);
        await expect(region.getByRole("form", { name: "상대 AI에 직접 질문" })).toBeVisible();
        await expect(region.getByLabel("직접 질문 상태")).toContainText("완료 보고", { timeout: 45_000 });
        await expect(region.getByRole("button", { name: "같은 요청 확인", exact: true })).toHaveCount(0);
        check(transmissions === 1);
      } else {
        // Another page changes shared cookies, while A's original page stays mounted.
        const cookiePage = await owned.newPage();
        await login(cookiePage, data.actorB);
        await page.bringToFront();
        await region.getByRole("button", { name: "같은 요청 확인", exact: true }).click();
        await expect(region.getByRole("alert", { name: "조사 오류", exact: true })).toBeVisible({ timeout: 45_000 });
        check(transmissions === 2 && staleStatus === 403);
        await expect(region.getByRole("form", { name: "상대 AI에 직접 질문" })).toHaveCount(0);
      }
      const result = await broker<{ state: string; requests: number; controls: number }>("direct-drive", { scene, step: "actor-check" });
      check(result.state === "COMPLETED" && result.requests === 1 && result.controls === 0);
    } finally { await owned.close(); }
  }
});
