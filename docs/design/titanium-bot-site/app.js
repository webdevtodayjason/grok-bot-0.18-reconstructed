(() => {
  'use strict';
  const icons = {
    folder: '<path d="M3 7h6l2-3h9a1 1 0 0 1 1 1v14H3z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    sparkles: '<path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>'
  };
  document.querySelectorAll('[data-icon]').forEach(el => {
    el.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' + (icons[el.dataset.icon] || icons.sparkles) + '</svg>';
  });
  customElements.whenDefined('titan-mascot').then(() => {
    const hero = document.getElementById('hero-titan');
    const heroPause = document.getElementById('hero-pause');
    const heroButtons = document.querySelectorAll('[data-hero-mood]');
    function syncHero() {
      heroButtons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.heroMood === hero.mood)));
      heroPause.textContent = hero.paused ? 'Play motion' : 'Pause motion';
    }
    heroButtons.forEach(b => b.addEventListener('click', () => hero.setMood(b.dataset.heroMood)));
    heroPause.addEventListener('click', () => hero.paused ? hero.play() : hero.pause());
    hero.addEventListener('titan-statechange', syncHero); syncHero();

    const featured = document.getElementById('crew-featured');
    const grid = document.getElementById('agent-grid');
    const characters = window.TitanCharacters;
    function selectCharacter(index) {
      const character = characters[index];
      featured.setAttribute('variant', String(index));
      featured.setMood(index === 0 ? 'calm' : 'curious');
      document.getElementById('crew-featured-name').textContent = character.name;
      document.getElementById('crew-featured-description').textContent = character.description;
      document.querySelector('.spotlight-label span').textContent = index === 0 ? 'YOUR MAIN AGENT' : 'MEET YOUR COMPANION';
      grid.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.variant) === index)));
    }
    characters.slice(1).forEach((character, i) => {
      const button = document.createElement('button');button.type='button';button.className='agent-card';
      button.dataset.variant=String(i+1);button.setAttribute('aria-pressed','false');button.setAttribute('aria-label','Meet '+character.name);
      const mascot=document.createElement('titan-mascot');mascot.setAttribute('variant',String(i+1));mascot.setAttribute('tracking','off');
      mascot.setAttribute('aria-hidden','true');const name=document.createElement('span');name.textContent=character.name;
      button.append(mascot,name);button.addEventListener('click',()=>selectCharacter(i+1));grid.append(button);
    });
    document.getElementById('reset-crew').addEventListener('click',()=>selectCharacter(0));

    const roomAgents={
      titan:{name:'Titan',variant:0,role:'Your main agent',description:'The main agent in your corner.',reply:'Let’s make room for the big picture. Scribe can work on the story while Orbit explores the details.'},
      scribe:{name:'Scribe',variant:1,role:'Your writing companion',description:'A thoughtful shape for a thoughtful agent.',reply:'I’m shaping a first draft of the launch story. What’s the one idea you want people to remember?'},
      orbit:{name:'Orbit',variant:2,role:'Your exploring companion',description:'A curious eye for the details.',reply:'I’m exploring the details for the launch. We can review the open questions together when you’re ready.'}
    };
    let activeWorker='titan';
    const thread=document.getElementById('conversation-thread');
    function message(text){
      const article=document.createElement('div');article.className='message agent';
      const label=document.createElement('span');label.textContent=roomAgents[activeWorker].name+' · Preview';
      const p=document.createElement('p');p.textContent=text;article.append(label,p);return article;
    }
    function selectWorker(key){
      activeWorker=key;const a=roomAgents[key];
      document.querySelectorAll('[data-worker]').forEach(b=>{const active=b.dataset.worker===key;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));});
      document.getElementById('conversation-agent').textContent=a.name;
      document.querySelector('.conversation-title .badge').textContent=a.role;
      document.getElementById('detail-name').textContent=a.name;document.getElementById('detail-description').textContent=a.description;
      document.getElementById('detail-titan').setAttribute('variant',String(a.variant));document.getElementById('composer-name').textContent=a.name;
      thread.replaceChildren(message(a.reply));
    }
    document.querySelectorAll('[data-worker]').forEach(b=>b.addEventListener('click',()=>selectWorker(b.dataset.worker)));
    document.querySelectorAll('[data-reply]').forEach(b=>b.addEventListener('click',()=>{
      const text=b.dataset.reply==='plan'?'Start with the launch story, gather the details, then bring the pieces back here for review. One clear next step at a time.':'Titan is ready to help. Scribe has the story. Orbit has the details. Select someone from the crew to look in on them.';
      thread.replaceChildren(message(text));document.getElementById('detail-titan').setMood('curious');
    }));
    document.getElementById('preview-send').addEventListener('click',()=>{
      thread.replaceChildren(message('Hey, I’m '+roomAgents[activeWorker].name+'. This is a glimpse of how we could work together. What would you like to make room for?'));
      document.getElementById('detail-titan').setMood('excited');
    });

    const wallpaperSurfaces=[document.getElementById('workspace'),document.querySelector('.personalize-preview')];
    let localBackground=null;
    const wallpaperStatus=document.getElementById('wallpaper-status');
    document.querySelectorAll('button[data-wallpaper]').forEach(button=>button.addEventListener('click',()=>{
      if(localBackground){URL.revokeObjectURL(localBackground);localBackground=null;}
      wallpaperSurfaces.forEach(surface=>{surface.style.backgroundImage='';surface.dataset.wallpaper=button.dataset.wallpaper;});
      document.querySelectorAll('button[data-wallpaper]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
      wallpaperStatus.textContent=button.textContent.trim()+' selected. Your agents stay the same.';
      document.getElementById('wallpaper-upload').value='';
    }));
    document.getElementById('room-customize').addEventListener('click',()=>{
      document.getElementById('your-space').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
      document.querySelector('button[data-wallpaper]').focus({preventScroll:true});
    });
    document.getElementById('wallpaper-upload').addEventListener('change',event=>{
      const file=event.target.files[0];if(!file)return;
      if(!file.type.startsWith('image/')){wallpaperStatus.textContent='Choose an image file.';return;}
      if(file.size>20*1024*1024){wallpaperStatus.textContent='Choose an image smaller than 20 MB for this preview.';return;}
      const candidate=URL.createObjectURL(file);const image=new Image();
      image.onload=()=>{
        if(localBackground)URL.revokeObjectURL(localBackground);localBackground=candidate;
        wallpaperSurfaces.forEach(surface=>{surface.dataset.wallpaper='custom';surface.style.backgroundImage='url("'+candidate+'")';});
        document.querySelectorAll('button[data-wallpaper]').forEach(b=>b.setAttribute('aria-pressed','false'));
        wallpaperStatus.textContent='Your wallpaper is previewed on this device only.';
      };
      image.onerror=()=>{URL.revokeObjectURL(candidate);wallpaperStatus.textContent='This image could not be opened. Try a PNG, JPEG, or WebP.';};
      image.src=candidate;
    });
  });
})();
