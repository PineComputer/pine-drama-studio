const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const studio=path.resolve(__dirname,'..'),native=process.env.VSCODE_DIR||'/tmp/pine-chat-review-vscode';
const {_electron}=require(path.join(native,'node_modules/playwright'));
const existing=process.env.PINE_TEST_EXISTING==='1',archive=process.env.PINE_TEST_ARCHIVE==='1',localReview=process.env.PINE_TEST_LOCAL_REVIEW==='1';
const fixture=path.join(studio,'.dev','entry-journey-'+Date.now());
for(const name of ['user-data','extensions','qa-extension'])fs.mkdirSync(path.join(fixture,name),{recursive:true});
const qa=path.join(fixture,'qa-extension');
fs.cpSync(path.join(studio,'extensions/pine-drama/out'),path.join(qa,'out'),{recursive:true});
fs.cpSync(path.join(studio,'extensions/pine-drama/media'),path.join(qa,'media'),{recursive:true});
fs.cpSync(path.join(studio,'extensions/pine-drama/node_modules'),path.join(qa,'node_modules'),{recursive:true});
const manifest=JSON.parse(fs.readFileSync(path.join(studio,'extensions/pine-drama/package.json'),'utf8'));manifest.main='main.cjs';
fs.writeFileSync(path.join(qa,'package.json'),JSON.stringify(manifest));
fs.writeFileSync(path.join(qa,'main.cjs'),`const v=require('vscode'),fs=require('fs'),path=require('path');
const {Store}=require('./out/core/store'),{ConversationService}=require('./out/core/conversations'),{projectSessions}=require('./out/core/projectSessions'),{registerPineSessions}=require('./out/pineSessions'),{FakePine,MemoryVault}=require('./out/test/fakePine'),{testPublication}=require('./out/test/publicationFixture'),{showInChatView}=require('./out/chatView');
exports.activate=ctx=>{
 const base=${JSON.stringify(fixture)},root=fs.realpathSync(v.workspace.workspaceFolders[0].uri.fsPath),store=new Store(path.join(base,'fixture.sqlite')),pine=new FakePine();
 pine.plans=[require('./out/test/reviewFixture').reviewPlan([{stage:'bible',version:'v1',files:{'bible.md':'# OFFLINE existing Bible'}},{stage:'screenplay',version:'v1'}]),{state:'completed',text:'OFFLINE continued after explicit review.'}];
 // This mode returns a Review of unchanged input files, with no returned-file cache entries.
 if(${localReview}&&!store.conversations().length){for(const [rel,bytes] of Object.entries(pine.plans[0].files)){const file=path.join(root,rel.slice('drama/'.length));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);}pine.plans[0].files={};}
 const vault=new MemoryVault(),snapshot=path.join(base,'offline-transport.bin');if(fs.existsSync(snapshot)){const saved=require('node:v8').deserialize(fs.readFileSync(snapshot));Object.assign(pine,saved.pine);Object.assign(vault,saved.vault);}
 const env={endpoint:'https://offline.invalid',apiKey:'offline'},key=projectSessions(root,store.conversations()).mainKey;
 if(!store.conversation(key))store.insertConversation({key,env:'offline',endpoint:env.endpoint,label:'OFFLINE interrupted first send',secret_ref:'offline'});
 let validations=0;let api,reviewApi,cli;const state=()=>{const c=store.conversation(key);fs.writeFileSync(path.join(base,'state.json'),JSON.stringify({key,validations,folder:c?.folder,role:c?.project_role,executor:c?.project_executor,run:pine.calls.run||0,state:c?.state,review:svc.openReview(key)?.review.id,accepts:cli?.calls.filter(c=>c[0]==='accept').length,answer:pine.calls.answer||0,calls:pine.calls,published:fs.existsSync(path.join(root,'progress.md')),turn:c?.current_turn_id}));};
 const svc=new ConversationService({store,port:pine,vault,pine:env,holder:'offline-fixture',validateProject:async root=>{require('./out/core/projectEntry').verifyProjectRoot(root,JSON.parse(fs.readFileSync(path.join(root,'drama-cli.cfg.yaml'),'utf8')));validations++;},files:{libraryRoot:path.join(base,'library'),projectsRoot:path.join(base,'projects')},publication:testPublication(base),approval:(args,start)=>cli.run(args,start),onChange:k=>{api?.refresh(k);reviewApi?.refresh(k);state();}});
 cli=require('./out/test/reviewFixture').approvalRunner(()=>svc.projectRoot(key));
 reviewApi=require('./out/reviewView').registerReviewView(ctx,v.window.createOutputChannel('OFFLINE Review'),svc,()=> 'OFFLINE Project Chat');reviewApi.scope(key,undefined);
 const output=v.window.createOutputChannel('OFFLINE Pine fixture'),append=output.appendLine.bind(output);output.appendLine=text=>{append(text);fs.appendFileSync(path.join(base,'provider.log'),text+'\\n');};
 api=registerPineSessions(ctx,output,{kind:'set',file:'OFFLINE fixture',pine:env},svc);
 const req=path.join(base,'request.json');let busy=false;
 const timer=setInterval(async()=>{if(busy||!fs.existsSync(req))return;busy=true;let r;
 try{r=JSON.parse(fs.readFileSync(req,'utf8'));fs.unlinkSync(req);let result;
 if(r.command==='qa.prepare'){await v.commands.executeCommand('workbench.action.chat.open',{query:'OFFLINE first send with attachment - fake transport only',isPartialQuery:true,attachFiles:[v.Uri.file(path.join(base,'screenplay.txt'))]});}
 else if(r.command==='qa.archiveStart'){pine.plans=[{state:'running'}];const events=pine.events.bind(pine);pine.events=async function*(...args){yield* events(...args);await new Promise(resolve=>{const poll=setInterval(()=>{if(fs.existsSync(path.join(base,'archive-progress'))){clearInterval(poll);resolve();}},25);});const c=store.conversation(key);yield {kind:'progress',taskId:c.task_id,turnId:c.current_turn_id,eventId:1000,text:'OFFLINE progress after view detach'};};await v.commands.executeCommand('workbench.action.chat.open',{query:'OFFLINE keep producing after archive',isPartialQuery:true});await v.commands.executeCommand('workbench.action.chat.submit');}
 else if(r.command==='qa.archive'){await v.commands.executeCommand('agentSession.archive',{$mid:25,session:{resource:v.Uri.parse(key)}});}
 else if(r.command==='qa.archiveFinish'){pine.finish(store.conversation(key).current_turn_id,{state:'completed',text:'OFFLINE result after archive',files:{'drama/progress.md':'OFFLINE returned after archive'}});}
 else if(r.command==='qa.archiveOpen'){await showInChatView((c,...a)=>v.commands.executeCommand(c,...a),{active:()=>v.window.tabGroups.activeTabGroup.activeTab,isOpen:t=>v.window.tabGroups.all.some(g=>g.tabs.includes(t)),close:t=>v.window.tabGroups.close(t)},v.Uri.parse(key));}
 else if(r.command==='qa.state'){state();}
 else if(r.command==='qa.snapshot'){fs.writeFileSync(snapshot,require('node:v8').serialize({pine,vault}));}
 else if(r.command==='qa.pendingStop'){store.updateConversation(key,{session_state:'ended'});const sdk=new (require('./out/sdkPort').SdkPort)();sdk.computer=async()=>({stop:async()=>false});pine.stopComputer=(env,credentials)=>sdk.stopComputer(env,credentials,'offline');const created=pine.calls.createSession;await v.commands.executeCommand('pineDrama.startNewSession',key);if(pine.calls.createSession!==created)throw new Error('Unconfirmed Stop started a successor');}
 else if(r.command==='qa.restartReady'){delete pine.stopComputer;store.updateConversation(key,{session_state:'ended',computer_state:'stopped',state:'idle'});}
 else if(r.command==='qa.holdRestart'){const ensure=pine.ensureComputer.bind(pine);pine.ensureComputer=async(...args)=>{fs.writeFileSync(path.join(base,'restart-entered'),'');await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{clearInterval(poll);reject(new Error('OFFLINE restart test timed out'));},15000);const poll=setInterval(()=>{if(fs.existsSync(path.join(base,'restart-release'))){clearInterval(poll);clearTimeout(timeout);resolve();}},50);});return ensure(...args);};fs.writeFileSync(path.join(base,'restart-before'),String(pine.calls.createSession||0));}
 else if(r.command==='qa.restartCheck'){if((pine.calls.createSession||0)!==Number(fs.readFileSync(path.join(base,'restart-before'),'utf8'))+1)throw new Error('Repeated clicks created extra remote sessions');if(store.conversation(key).session_state!=='open')throw new Error('Restart did not finish');}
 else if(r.command==='qa.preview'){const file=path.join(base,'review.md');fs.writeFileSync(file,'# OFFLINE review preview');await v.commands.executeCommand('vscode.open',v.Uri.file(file));await v.commands.executeCommand('markdown.togglePreview');}
 else if(r.command==='qa.localReviewCheck'){const view=svc.openReview(key);if(!view||view.review.items.some(i=>i.files.some(f=>f.here===false)))throw new Error('Existing local review files were not available');for(const item of view.review.items)for(const file of item.files)if(store.libraryFileBySha(key,file.relPath,file.sha))throw new Error('Fixture unexpectedly relied on returned-file cache');if(v.window.activeTextEditor?.document.uri.fsPath!==path.join(root,'bible/v1/bible.md'))throw new Error('Bible link did not open the exact local file');}
 else if(r.command==='qa.refresh'){api.refresh(key);}
 else if(r.command==='qa.draft'){await v.commands.executeCommand('workbench.action.chat.open',{query:'OFFLINE unsent draft survives review',isPartialQuery:true,attachFiles:[v.Uri.file(path.join(base,'screenplay.txt'))]});}
 else result=await v.commands.executeCommand(r.command,...(r.args||[]));state();
 fs.writeFileSync(path.join(base,'response-'+r.id+'.json'),JSON.stringify({ok:true,result}));
 }catch(e){fs.writeFileSync(path.join(base,'response-'+(r?.id||'error')+'.json'),JSON.stringify({ok:false,error:String(e)}));}finally{busy=false;}},80);
 ctx.subscriptions.push({dispose(){clearInterval(timer);store.close();}});
 void(async()=>{await v.commands.executeCommand('pine.workbench.prepareProjectChat',key);await showInChatView((c,...a)=>v.commands.executeCommand(c,...a),{active:()=>v.window.tabGroups.activeTabGroup.activeTab,isOpen:t=>v.window.tabGroups.all.some(g=>g.tabs.includes(t)),close:t=>v.window.tabGroups.close(t)},v.Uri.parse(key));state();fs.writeFileSync(path.join(base,'ready'),'ready');})().catch(e=>fs.writeFileSync(path.join(base,'activation-error'),String(e)));
};`);
const film=path.join(fixture,existing?'OFFLINE Existing Project':'OFFLINE First Send');fs.mkdirSync(film);if(existing)fs.writeFileSync(path.join(film,'drama-cli.cfg.yaml'),JSON.stringify({project:fs.realpathSync(film)}));fs.writeFileSync(path.join(fixture,'screenplay.txt'),'OFFLINE screenplay fixture.');
const allow=new Set(fs.readFileSync(path.join(studio,'upstream/builtin-extensions.allow'),'utf8').split(/\r?\n/)),disabled=[];
for(const name of fs.readdirSync(path.join(native,'extensions'))){const dir=path.join(native,'extensions',name),file=path.join(dir,'package.json');if(!fs.existsSync(file))continue;const p=JSON.parse(fs.readFileSync(file,'utf8'));let built=true;if(p.main)try{require.resolve(path.resolve(dir,p.main));}catch{built=false;}if(!allow.has(`${p.publisher}.${p.name}`)||!built)disabled.push('--disable-extension',`${p.publisher}.${p.name}`);}
let seq=0;
async function until(test,description,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await test())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out: '+description);}
async function send(command,args=[],wait=true){const id=++seq;fs.writeFileSync(path.join(fixture,'request.json'),JSON.stringify({id,command,args}));if(!wait){await until(()=>!fs.existsSync(path.join(fixture,'request.json')),'request consumed');return;}const response=path.join(fixture,`response-${id}.json`);await until(()=>fs.existsSync(response),command);const r=JSON.parse(fs.readFileSync(response,'utf8'));assert(r.ok,r.error);return r.result;}
(async()=>{const app=await _electron.launch({executablePath:path.join(native,'.build/electron/Code - OSS.app/Contents/MacOS/Code - OSS'),args:[native,'--user-data-dir',path.join(fixture,'user-data'),'--extensions-dir',path.join(fixture,'extensions'),'--extensionDevelopmentPath',qa,'--disable-workspace-trust',...disabled,film],cwd:native,env:{...process.env,VSCODE_DEV:'1',VSCODE_CLI:'1',VSCODE_SKIP_PRELAUNCH:'1',PINE_DRAMA_ENV_FILE:'/tmp/pine-s2-no-credentials'},timeout:30000});
let p;try{
 await app.evaluate(({app,BrowserWindow,dialog},visible)=>{if(!visible){app.dock?.hide();for(const w of BrowserWindow.getAllWindows())w.hide();BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.showInactive=function(){};app.on('browser-window-created',(_,w)=>w.hide());}globalThis.qaDialogs=[];
 dialog.showSaveDialog=async(...args)=>{const options=args.at(-1);globalThis.qaDialogs.push({kind:'save',options});return {canceled:false,filePath:globalThis.qaDestination};};
 dialog.showOpenDialog=async(...args)=>{globalThis.qaDialogs.push({kind:'open',options:args.at(-1)});return {canceled:false,filePaths:[globalThis.qaDestination]};};},process.env.PINE_TEST_VISIBLE==='1');
 p=await app.firstWindow();p.setDefaultTimeout(15000);await p.setViewportSize({width:1440,height:900});await until(()=>fs.existsSync(path.join(fixture,'ready')),'QA activation');
 assert.equal(JSON.parse(fs.readFileSync(path.join(fixture,'state.json'),'utf8')).validations,0,'navigation starts no validation/admission');
 if(archive){
  const read=()=>JSON.parse(fs.readFileSync(path.join(fixture,'state.json'),'utf8'));
  await send('qa.archiveStart');
  await until(()=>read().state==='running'&&read().turn,'running task before native archive');
  const run=read().run;
  await send('qa.archive');
  await until(async()=>!(await p.locator('body').innerText()).includes('OFFLINE keep producing after archive'),'native archive clears active Chat');
  await send('qa.state');
  assert.equal(read().calls.stopComputer||0,0,'native archive sends no remote shutdown');
  assert.equal(read().state,'running');
  await until(()=>fs.existsSync(path.join(fixture,'provider.log'))&&fs.readFileSync(path.join(fixture,'provider.log'),'utf8').includes("a reply's view ended"),'native archive cancels the local reply');
  fs.writeFileSync(path.join(fixture,'archive-progress'),'');
  await new Promise(resolve=>setTimeout(resolve,300));
  await send('qa.archiveFinish');
  // Native archive detaches this reply. Record whether publication waits for reopening (known follow-up).
  await new Promise(resolve=>setTimeout(resolve,1000));await send('qa.state');
  console.log('ARCHIVED COMPLETION',read());
  assert.equal(read().published,false,'known follow-up: a detached reply defers local publication');
  await p.screenshot({path:'/tmp/pine-local-archive-detached.png'});
  await send('qa.archiveOpen');
  await until(()=>read().state==='idle','reopening settles archived task');
  assert.equal(read().run,run,'opening history sends no work');
  assert.equal(read().calls.stopComputer||0,0);
  assert.equal(read().published,true,'returned progress is published after reopening');
  await p.screenshot({path:'/tmp/pine-local-archive-reopened.png'});
  await send('workbench.action.showCommands');
  await p.locator('.quick-input-widget input').fill('>Developer: Pine: Stop');
  await until(async()=>(await p.locator('.quick-input-widget').innerText()).includes('Stop All Computers'),'developer-only shutdown palette');
  await p.screenshot({path:'/tmp/pine-local-archive-developer-commands.png'});
  console.log('PASS native archive: no remote shutdown or new send; reopened result published.');
  return;
 }

 await send('qa.prepare');
 await p.locator('.interactive-input-editor .native-edit-context').focus();
 await send('workbench.action.chat.submit');
 await until(()=>{const s=JSON.parse(fs.readFileSync(path.join(fixture,'state.json'),'utf8'));return s.run===1&&s.state==='needs_input';},'real provider first send with FakePine');
 const state=JSON.parse(fs.readFileSync(path.join(fixture,'state.json'),'utf8'));
 assert.equal(state.validations,existing?1:0);
 assert.equal(state.folder,fs.realpathSync(film));assert.equal(state.role,'main');assert.equal(state.executor,1);
 const body=await p.locator('body').innerText();assert(!body.includes('entry belongs to another conversation'));
 await until(async()=>{for(const f of p.frames()){if((await f.locator('body').innerText().catch(()=>'' )).includes('Approve all'))return true;}return false;},'inline Review renderer');
 let card;for(const f of p.frames()){if((await f.locator('body').innerText().catch(()=>'' )).includes('Approve all'))card=f;}
 assert(!(await card.locator('body').innerText()).includes('Please review these exact versions.'),'agent explanation is not repeated inside the card');
 assert(!(await p.locator('body').innerText()).includes('Your next message answers it'),'item review never requests ordinary Chat input');
 if(localReview){await card.getByRole('button',{name:'bible.md',exact:true}).click();await until(async()=> (await p.locator('body').innerText()).includes('OFFLINE existing Bible'),'existing Bible opened in center editor');await send('qa.localReviewCheck');}
 await card.getByRole('button',{name:'Approve all',exact:true}).click();
 await until(async()=> (await card.locator('body').innerText()).includes('2 approved'),'bulk draft rendered');
 assert.equal(await card.getByRole('button',{name:'Approved',exact:true}).count(),2);
 await until(async()=>await card.getByRole('button',{name:'Approve all',exact:true}).evaluate(el=>getComputedStyle(el).borderTopStyle)==='solid','bulk button stylesheet loaded');
 await p.screenshot({path:existing?'/tmp/pine-s3-existing-review.png':'/tmp/pine-chat-review-renderer.png'});
 const pending=JSON.parse(fs.readFileSync(path.join(fixture,'state.json'),'utf8'));
 assert.equal(pending.accepts,0);
 if(localReview){await p.screenshot({path:'/tmp/pine-existing-bible-review.png'});console.log('PASS native existing-file Review: exact local Bible opens, approval draft enabled, no returned-file cache needed.');}
 await send('qa.snapshot');
 fs.unlinkSync(path.join(fixture,'ready'));
 await send('workbench.action.reloadWindow',[],false);
 await until(()=>fs.existsSync(path.join(fixture,'ready')),'restored pending fixture',60000);
 for(let visit=0;visit<4;visit++){
  await send('pine.sessionReview.focus');
  await send('pineDrama.review.openMessage',[pending.key,pending.review]);
  // This fixture hides its Electron window; capture forces a compositor frame after webview reparenting.
  await p.screenshot({path:'/tmp/pine-review-reveal-'+visit+'.png'});
  await until(async()=>{for(const f of p.frames()){if((await f.locator('body').innerText().catch(()=>'' )).includes('Approve all')){card=f;return true;}}return false;},'review card after index visit '+visit);
  assert.equal(await card.getByRole('button',{name:'Approved',exact:true}).count(),2);
 }
 await send('qa.draft');

 await card.getByRole('button',{name:'Change',exact:true}).nth(1).click();
 await until(async()=>await card.locator('textarea').count()===1,'change note');
 await card.locator('textarea').fill('OFFLINE keep the ending');
 await send('qa.refresh');
 assert.equal(await card.locator('textarea').inputValue(),'OFFLINE keep the ending');
 await card.getByRole('button',{name:'Submit and continue',exact:true}).click();
 await until(()=>{const s=JSON.parse(fs.readFileSync(path.join(fixture,'state.json'),'utf8'));return s.state==='idle'&&s.answer===1;},'review submit and continuation');
 assert.equal(JSON.parse(fs.readFileSync(path.join(fixture,'state.json'),'utf8')).accepts,1);
 await until(async()=> (await p.locator('body').innerText()).replace(/\u00a0/g,' ').includes('OFFLINE unsent draft survives review'),'preserved composer draft');
 assert((await p.locator('body').innerText()).includes('screenplay.txt'),'retained unsent attachment');
 await p.screenshot({path:'/tmp/pine-chat-review-submitted.png'});
 await send('qa.snapshot');
 await send('pine.sessionReview.focus');
 await p.screenshot({path:'/tmp/pine-chat-review-index.png'});
 fs.unlinkSync(path.join(fixture,'ready'));
 await send('workbench.action.reloadWindow',[],false);
 await until(()=>fs.existsSync(path.join(fixture,'ready')),'restored fixture extension',60000);
 for(let visit=0;visit<4;visit++){
  await send('pine.sessionReview.focus');
  await send('pineDrama.review.openMessage',[pending.key,pending.review]);
  // This fixture hides its Electron window; capture forces a compositor frame after webview reparenting.
  await p.screenshot({path:'/tmp/pine-review-reveal-'+visit+'.png'});
  // Electron retains the reparented webview frames even when Playwright loses their targets after reload.
  // Inspect the real renderer DOM through WebFrameMain and exercise the receipt's collapse control.
  await until(()=>app.evaluate(async({webContents})=>{
   for(const contents of webContents.getAllWebContents())for(const frame of contents.mainFrame.framesInSubtree){
    try{if(await frame.executeJavaScript(`(()=>{const s=document.querySelector('summary');if(!s?.textContent.includes('Reviewed'))return false;const d=s.parentElement,before=d.open;s.click();const toggled=d.open!==before;s.click();return toggled&&d.open===before;})()`))return true;}catch{/* a frame may be disposed while native Chat reparents it */}
   }return false;
  }),'restored interactive receipt visit '+visit);
 }
 await send('qa.preview');
 await until(async()=>{for(const f of p.frames()){if(await f.getByRole('heading',{name:'OFFLINE review preview',exact:true}).count().catch(()=>0))return true;}return false;},'built-in Markdown preview renders');
 await p.screenshot({path:'/tmp/pine-chat-review-history.png'});
 await send('qa.pendingStop');
 await until(async()=> (await p.locator('body').innerText()).includes('Computer shutdown is not confirmed'),'unconfirmed Stop refusal');
 await p.screenshot({path:'/tmp/pine-s3-stop-confirmation.png'});
 await send('qa.restartReady');
 await send('qa.snapshot');
 fs.unlinkSync(path.join(fixture,'ready'));
 await send('workbench.action.reloadWindow',[],false);
 await until(()=>fs.existsSync(path.join(fixture,'ready')),'reopened ended Chat',60000);
 const restartButton=p.getByRole('button',{name:'Start the agent again',exact:true});
 await restartButton.waitFor();
 await p.screenshot({path:'/tmp/pine-restart-reopened.png'});
 await send('qa.holdRestart');
 await restartButton.click();
 await until(()=>fs.existsSync(path.join(fixture,'restart-entered')),'startup entered');
 await restartButton.click();
 await until(async()=> (await p.locator('body').innerText()).includes('Starting the agent…'),'visible startup progress');
 await p.screenshot({path:'/tmp/pine-restart-progress.png'});
 fs.writeFileSync(path.join(fixture,'restart-release'),'');
 await until(async()=> (await p.locator('body').innerText()).includes('The agent starts again on Computer'),'restart completed');
 await send('qa.restartCheck');
 assert(!(await p.locator('body').innerText()).includes('still has a live session'),'double click has no contradictory second notice');
 console.log('PASS native restart: reopened action, visible progress, duplicate clicks create one Session.');
 console.log('PASS native Chat review: bulk draft only, mixed submit, exact-message navigation, retained composer draft, one local approval and one FakePine continuation.');
 console.log('FINAL STATE',JSON.parse(fs.readFileSync(path.join(fixture,'state.json'),'utf8')));
} catch(e){if(p&&!p.isClosed()){console.log('FRAMES',await Promise.all(p.frames().map(async f=>({url:f.url(),body:(await f.locator('body').innerText().catch(()=>'' )).slice(0,400),summaries:await f.locator('summary').count().catch(()=>0)}))));console.log('BODY',(await p.locator('body').innerText()).slice(-2200));await p.screenshot({path:'/tmp/pine-chat-review-diagnostic.png'});}throw e;}finally{await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
