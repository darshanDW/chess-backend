const $ = id => document.getElementById(id);
let socket, state = null, myId = null, selected = null, legalTargets = [], lastFen = "";
const pieces = { w: { k:"♔",q:"♕",r:"♖",b:"♗",n:"♘",p:"♙" }, b:{ k:"♚",q:"♛",r:"♜",b:"♝",n:"♞",p:"♟" } };
function toast(message) { const el=$("toast"); el.textContent=message; el.classList.remove("hidden"); setTimeout(()=>el.classList.add("hidden"),2600); }
function send(type,data={}) { if(socket?.readyState===WebSocket.OPEN) socket.send(JSON.stringify({type,...data})); else toast("Connection is not ready."); }
function connect(onOpen) {
  const proto=location.protocol==="https:"?"wss":"ws";
  socket=new WebSocket(`${proto}://${location.host}`);
  socket.onopen=()=>onOpen();
  socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==="joined"){myId=m.you;if(m.token){localStorage.setItem("chessPartySession",JSON.stringify({code:m.room.code,token:m.token}));}render(m.room);$("home").classList.add("hidden");$("room").classList.remove("hidden");}else if(m.type==="state"){myId=m.you;render(m.room);}else if(m.type==="error")toast(m.message);};
  socket.onclose=()=>toast("Connection lost. Refresh to reconnect.");
  socket.onerror=()=>toast("Could not connect to the game server.");
}
function tryResume(){
  let saved;try{saved=JSON.parse(localStorage.getItem("chessPartySession")||"null");}catch{}
  if(!saved?.code||!saved?.token)return;
  connect(()=>send("resume",{code:saved.code,token:saved.token}));
}
$("create-form").addEventListener("submit",e=>{e.preventDefault();connect(()=>send("create",{name:$("host-name").value,teamName:$("host-team").value,durationMinutes:Number($("duration").value)}));});
$("join-form").addEventListener("submit",e=>{e.preventDefault();connect(()=>send("join",{name:$("join-name").value,code:$("room-code").value}));});
$("copy-code").onclick=async()=>{try{await navigator.clipboard.writeText(state.code);toast("Room code copied.");}catch{toast("Room code: "+state.code);}};
$("ready-btn").onclick=()=>send("ready",{ready:true});
$("start-btn").onclick=()=>send("start");
$("resign-btn").onclick=()=>{if(confirm("Resign this chess match?"))send("resign");};
function teamOf(id){return state?.teams.find(t=>t.id===id);}
function playerOf(id){return state?.players.find(p=>p.id===id);}
function render(room){
  state=room;$("room-code-label").textContent=room.code;$("player-count").textContent=`${room.players.length} / 8`;
  const me=room.players.find(p=>p.id===myId);const isHost=myId===room.hostId;
  $("room-status").textContent=room.phase==="playing"?"Tournament in progress":room.phase==="finished"?"Tournament finished":`${room.players.filter(p=>p.ready).length} ready · ${room.players.length} joined`;
  $("ready-btn").classList.toggle("hidden",!me||me.ready||room.phase!=="lobby");
  $("start-btn").classList.toggle("hidden",!isHost||room.phase!=="lobby");
  $("start-btn").disabled=![2,4,6,8].includes(room.players.length)||room.players.some(p=>!p.ready||!p.connected);
  $("teams-list").innerHTML=room.teams.map(t=>`<div class="team-card"><div class="team-name">${escapeHtml(t.name)}</div>${room.players.filter(p=>p.teamId===t.id).map(p=>`<div class="player-row"><span class="avatar">${escapeHtml(p.name.slice(0,1).toUpperCase())}</span>${escapeHtml(p.name)}<span class="status-dot ${p.connected?"":"off"}"></span></div>`).join("")||'<div class="player-row muted">Waiting for teammate</div>'}</div>`).join("");
  $("leaderboard").innerHTML=room.teams.slice().sort((a,b)=>b.points-a.points||b.wins-a.wins).map((t,i)=>`<div class="leader-row"><div class="rank">0${i+1}</div><div><div class="leader-name">${escapeHtml(t.name)}</div><div class="leader-meta">${t.wins}W · ${t.draws}D · ${t.losses}L</div></div><div class="points">${t.points}</div></div>`).join("")||'<p class="hint">Teams appear as players join.</p>';
  $("match-panel").classList.toggle("hidden",!room.match);
  if(room.match)renderMatch(room.match);
  $("history").innerHTML=room.history.slice().reverse().map(h=>`<div class="history-item"><div><strong>${escapeHtml(h.whiteTeam)} vs ${escapeHtml(h.blackTeam)}</strong><small>${escapeHtml(h.whitePlayer)} · ${escapeHtml(h.blackPlayer)}</small></div><div>${escapeHtml(h.result)}<small>${escapeHtml(h.reason)}</small></div></div>`).join("")||'<p class="hint">Completed matches will appear here.</p>';
  if(room.phase==="finished")toast("Tournament finished! Check the leaderboard.");
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function fenBoard(fen){const placement=fen.split(" ")[0].split("/");const b=[];for(const row of placement){for(const ch of row){if(/[1-8]/.test(ch)){for(let i=0;i<Number(ch);i++)b.push(null);}else b.push(ch);}}return b;}
function renderMatch(m){
  const white=playerOf(m.whiteId),black=playerOf(m.blackId),wt=teamOf(white?.teamId),bt=teamOf(black?.teamId);
  $("match-title").textContent=`${wt?.name||"White"} vs ${bt?.name||"Black"}`;
  $("white-player").innerHTML=`<span>♙ ${escapeHtml(white?.name||"White")} <small>· ${escapeHtml(wt?.name||"")}</small></span><small>WHITE</small>`;
  $("black-player").innerHTML=`<span>♟ ${escapeHtml(black?.name||"Black")} <small>· ${escapeHtml(bt?.name||"")}</small></span><small>BLACK</small>`;
  $("white-clock").textContent=formatClock(m.clocks.white);$("black-clock").textContent=formatClock(m.clocks.black);
  $("turn-label").textContent=m.status==="active"?(m.turn==="w"?"White to move":"Black to move"):(m.result?.text||"Match complete");
  $("match-state").innerHTML=m.status==="active"?'<i></i> IN PLAY':'MATCH COMPLETE';
  $("match-result").classList.toggle("hidden",!m.result);$("match-result").textContent=m.result?`${m.result.text} · ${m.result.reason}`:"";
  const board=$("board");board.innerHTML="";
  const cells=fenBoard(m.fen);
  cells.forEach((piece,index)=>{
    const r=Math.floor(index/8),c=index%8,sq="abcdefgh"[c]+(8-r);
    const el=document.createElement("div");el.className=`square ${(r+c)%2?"dark":"light"}`;
    if(m.lastMove&&(m.lastMove.from===sq||m.lastMove.to===sq))el.classList.add("last");
    if(selected===sq)el.classList.add("selected");
    if(legalTargets.includes(sq))el.classList.add(piece?"capture":"target");
    if(c===0){const co=document.createElement("span");co.className="coords";co.textContent=8-r;el.append(co);}
    if(r===7){const co=document.createElement("span");co.className="coords";co.style.left="auto";co.style.top="auto";co.style.right="4px";co.style.bottom="2px";co.textContent="abcdefgh"[c];el.append(co);}
    if(piece){const color=piece===piece.toUpperCase()?"w":"b";el.append(document.createTextNode(pieces[color][piece.toLowerCase()]));}
    el.addEventListener("click",()=>squareClick(sq,piece,m));board.append(el);
  });
  const me=playerOf(myId);$("resign-btn").classList.toggle("hidden",!me||![m.whiteId,m.blackId].includes(myId)||m.status!=="active");
}
function formatClock(ms){const sec=Math.max(0,Math.ceil(ms/1000));return `${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`;}
function pseudoLegalTargets(from,fen){
  // The server is authoritative. This client highlights plausible destinations;
  // rejected moves are never applied locally. chess.js validates every submitted move.
  const b=fenBoard(fen),files="abcdefgh",rank=8-Number(from[1]),file=files.indexOf(from[0]),idx=rank*8+file,p=b[idx];if(!p)return[];
  const white=p===p.toUpperCase(),color=white?"w":"b",targets=[];
  const add=(r,c)=>{if(r<0||r>7||c<0||c>7)return false;const q=b[r*8+c];if(q&&((q===q.toUpperCase())===white))return false;targets.push(files[c]+(8-r));return !q;};
  const kind=p.toLowerCase();
  if(kind==="p"){const d=white?-1:1;if(!b[(rank+d)*8+file]&&rank+d>=0&&rank+d<8){add(rank+d,file);if(rank===(white?6:1)&&!b[(rank+2*d)*8+file])add(rank+2*d,file);}for(const dc of [-1,1]){const rr=rank+d,cc=file+dc;if(rr>=0&&rr<8&&cc>=0&&cc<8&&b[rr*8+cc]&&((b[rr*8+cc]===b[rr*8+cc].toUpperCase())!==white))targets.push(files[cc]+(8-rr));}}
  else if(kind==="n"){for(const[dr,dc]of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])add(rank+dr,file+dc);}
  else{const dirs=kind==="b"?[[-1,-1],[-1,1],[1,-1],[1,1]]:kind==="r"?[[-1,0],[1,0],[0,-1],[0,1]]:[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];for(const[dr,dc]of dirs){let rr=rank+dr,cc=file+dc;while(rr>=0&&rr<8&&cc>=0&&cc<8){const empty=add(rr,cc);if(!empty||kind==="k")break;rr+=dr;cc+=dc;}}}
  return targets;
}
function squareClick(sq,piece,m){
  if(m.status!=="active")return;
  const isWhite=piece&&piece===piece.toUpperCase(),turn=m.turn;
  const mine=(turn==="w"&&myId===m.whiteId)||(turn==="b"&&myId===m.blackId);
  if(!mine)return toast("You are spectating this match.");
  if(selected&&legalTargets.includes(sq)){const promotion=sq[1]==="8"||sq[1]==="1"?"q":undefined;send("move",{from:selected,to:sq,promotion});selected=null;legalTargets=[];return;}
  if(piece&&((turn==="w"&&isWhite)||(turn==="b"&&!isWhite))){selected=sq;legalTargets=pseudoLegalTargets(sq,m.fen);renderMatch(m);}
  else{selected=null;legalTargets=[];renderMatch(m);}
}
setInterval(()=>{if(!state?.match||state.match.status!=="active")return;const m=state.match;const elapsed=Date.now()-m.startedAt; // visual clocks are refreshed by server snapshots
  // Server snapshots arrive twice per second; this interval only updates display labels.
},1000);

tryResume();
