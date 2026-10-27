from pathlib import Path
import html
P=Path('public/covers');P.mkdir(parents=True,exist_ok=True)
def svg(id,bg,body):
 P.joinpath(id+'.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="500" height="680" viewBox="0 0 500 680"><defs><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".09"/></feComponentTransfer><feBlend in="SourceGraphic" mode="multiply"/></filter></defs><rect width="500" height="680" fill="{bg}"/>{body}<rect width="500" height="680" filter="url(#grain)" opacity=".06"/></svg>')
def text(y,t,size=32,color='#f8f0d9',extra=''):
 return f'<text x="250" y="{y}" text-anchor="middle" fill="{color}" font-family="Georgia, serif" font-size="{size}" {extra}>{html.escape(t)}</text>'
b=''
for i in range(15,0,-1):
 c=['#753b31','#e7b389','#b4593d'][i%3]
 b+=f'<ellipse cx="250" cy="420" rx="{34+i*19}" ry="{30+i*23}" fill="none" stroke="{c}" stroke-width="12" transform="rotate({i*6} 250 420)"/>'
b+='<path d="M254 353l-12 20 10 16-21 29 43-8-11-25 9-17z" fill="#f9edcd"/><circle cx="260" cy="348" r="9" fill="#f9edcd"/><path d="M253 393l-11 43m18-45 9 37" stroke="#f9edcd" stroke-width="6"/><rect width="500" height="240" fill="#bf6044"/>'+text(62,'LEWIS CARROLL',18,extra='letter-spacing="5"')+text(127,'Alice’s Adventures',37)+text(174,'in Wonderland',40)+text(638,'A WORLD BEYOND THE ORDINARY',11,extra='letter-spacing="3"')
svg('alice','#bf6044',b)
b='<rect x="38" y="30" width="424" height="620" fill="none" stroke="#a2bcb1"/><path d="M85 550V330a165 165 0 0 1 330 0v220z" fill="#91a99c"/><path d="M250 165v385M85 340h330" stroke="#123c3a" stroke-width="9"/><path d="M116 550l25-173 25-18 1-55 64-43 84 21 8 50 27 22-17 31-33 5 4 50 54 110z" fill="#123c3a"/><path d="M160 301l141-29 34 36-180 25z" fill="#123c3a"/>'+text(77,'ARTHUR CONAN DOYLE',17,extra='letter-spacing="3"')+text(122,'THE ADVENTURES OF',20)+text(590,'Sherlock Holmes',40)
svg('sherlock','#123c3a',b)
b='<rect x="30" y="30" width="440" height="620" rx="210" fill="none" stroke="#c8d0a2"/>'
for side in [0,1]:
 for i in range(10):
  x=65+side*370;y=90+i*57;dx=-55 if side else 55;ex=60 if side else -60;c=['#a1ac73','#c6cba0','#e8d7ac'][i%3]
  b+=f'<path d="M{x} {y+30}q{dx} -75 0 -65q{ex} 30 0 65" fill="{c}"/>'
b+=text(217,'JANE AUSTEN',21,extra='letter-spacing="5"')+text(316,'Pride',66)+text(375,'and',32)+text(445,'Prejudice',61)+text(565,'A NOVEL',14,extra='letter-spacing="6"')
svg('pride','#626f4d',b)
b='<path d="M-20 580L120 220l125 95 92-139 185 395" fill="none" stroke="#302c25" stroke-width="52"/><path d="M200 230l75 100-75 83 87 129-19 138" fill="none" stroke="#f4dab2" stroke-width="17"/><path d="M123 293l82 29m94-24 81-44" stroke="#f4dab2" stroke-width="12"/>'+text(75,'MARY SHELLEY',20,'#282922',extra='letter-spacing="5"')+text(153,'FRANKENSTEIN',42,'#282922')+text(622,'THE MODERN PROMETHEUS',13,'#282922',extra='letter-spacing="4"')
svg('frankenstein','#dc9d56',b)
b=''
for i in range(12):
 r=65+i*24;b+=f'<ellipse cx="250" cy="445" rx="{r}" ry="{r*.65}" fill="none" stroke="#b1a6ca" stroke-width="2" transform="rotate({i*8} 250 445)"/>'
b+='<circle cx="250" cy="445" r="36" fill="#e2d9cc"/><path d="M250 445l-12-22m12 22 20 3" stroke="#4a405c" stroke-width="3"/>'+text(66,'H. G. WELLS',20,extra='letter-spacing="5"')+text(145,'THE TIME',47)+text(201,'MACHINE',47)+text(633,'A JOURNEY INTO TOMORROW',12,extra='letter-spacing="3"')
svg('time','#51475f',b)
b='<circle cx="250" cy="393" r="150" fill="#d8cbb5"/><path d="M164 546l28-111-10-63 24-80 74-17 49 48-10 60-29 18-8 62 46 83z" fill="#a29884"/><path d="M210 290l-36 20 6 71 27-8 5-37 35-13 26-40z" fill="#8c8373"/><path d="M266 358l32 5-10 12m-19 42 25-4" fill="none" stroke="#746d60" stroke-width="4"/>'+text(70,'MARCUS AURELIUS',18,'#564e3f',extra='letter-spacing="4"')+text(157,'MEDITATIONS',43,'#564e3f')+text(616,'THE ART OF A THOUGHTFUL LIFE',12,'#564e3f',extra='letter-spacing="3"')
svg('meditations','#e6ddca',b)
b=''
for i in range(7):
 x=35+i*31;b+=f'<path d="M{x} 645V320L250 {190+i*24} {500-x} 320v325" fill="none" stroke="#b89a57" stroke-width="2"/>'
b+='<path d="M200 395q50-38 100 0m-100 0q50 32 100 0" stroke="#e4cc88" stroke-width="4" fill="none"/><circle cx="250" cy="395" r="9" fill="#e4cc88"/>'+text(67,'F. SCOTT FITZGERALD',17,extra='letter-spacing="3"')+text(136,'THE GREAT',41)+text(192,'GATSBY',52)+text(610,'A NOVEL',13,extra='letter-spacing="6"')
svg('gatsby','#192d39',b)
b='<circle cx="250" cy="330" r="110" fill="#e4b592"/><path d="M0 560l172-196 82 85 68-125 178 236v120H0z" fill="#321f28"/><path d="M0 612l181-126 78 53 86-59 155 132v68H0z" fill="#612b32"/>'+text(71,'SUN TZU',20,extra='letter-spacing="7"')+text(153,'THE ART',46)+text(207,'OF WAR',46)+text(635,'WISDOM THROUGH THE AGES',12,extra='letter-spacing="3"')
svg('war','#8c4444',b)
Path('public/icon.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="48" fill="#d96d4b"/><g fill="#fff8eb"><rect x="45" y="70" width="15" height="52" rx="7.5"/><rect x="74" y="43" width="15" height="106" rx="7.5"/><rect x="103" y="57" width="15" height="78" rx="7.5"/><rect x="132" y="78" width="15" height="36" rx="7.5"/></g></svg>')
