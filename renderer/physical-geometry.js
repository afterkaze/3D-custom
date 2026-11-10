// CSS mesh builder. Never clip/filter the parent: that flattens its children.
// Performance: every clip-path inside a 3D scene becomes its own offscreen render surface, redrawn on every
// frame the model moves (twice in stereo). Rectangles and rounded rectangles are therefore drawn as sized,
// border-radius boxes, and the sub-pixel bevel strips are left unclipped; only irregular outlines are clipped.
const PhysicalGeometry=(()=>{
  const node=cls=>{const n=document.createElement('div');n.className=cls;return n};
  const rectangle='0,0 100,0 100,100 0,100';
  function rounded(radius=4,steps=4){
    const points=[];
    for(const [cx,cy,start] of [[100-radius,radius,-90],[100-radius,100-radius,0],[radius,100-radius,90],[radius,radius,180]])
      for(let i=0;i<=steps;i++){const a=(start+i*90/steps)*Math.PI/180;points.push([cx+radius*Math.cos(a),cy+radius*Math.sin(a)].join(','))}
    // The radius travels with the outline so caps can use border-radius instead of a clip-path.
    return Object.assign(new String(points.join(' ')),{radius});
  }
  const isRectangle=points=>{const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys),near=(v,a)=>Math.abs(v-a)<.01;
    return points.length===4&&points.every(([x,y])=>(near(x,x0)||near(x,x1))&&(near(y,y0)||near(y,y1)));};
  function prism({width,height,depth,outline=rectangle,bevel=.6,className='',color}){
    const root=node('physical-solid '+className),front=node('solid-cap solid-front'),back=node('solid-cap solid-back');
    root.style.cssText=`width:${width}px;height:${height}px;--solid-depth:${depth}px`;
    if(color)root.style.setProperty('--solid-color',color);
    const raw=outline.trim().split(/\s+/).map(p=>p.split(',').map(Number)).map(([x,y])=>[x*width/100,y*height/100]);
    const points=raw.filter((p,i)=>Math.hypot(p[0]-raw[(i+raw.length-1)%raw.length][0],p[1]-raw[(i+raw.length-1)%raw.length][1])>.0001);
    const lengths=points.map((p,i)=>Math.hypot(p[0]-points[(i+1)%points.length][0],p[1]-points[(i+1)%points.length][1]));
    // Bevels thinner than half a pixel cannot be seen but each adds two 3D pieces per edge to sort and draw.
    let b=Math.min(bevel,depth/3,...lengths.map(l=>l/3));if(b<.5)b=0;
    // Intersect offset edge lines: a thin rail needs the same small inset at its
    // ends as at its sides, rather than shrinking the entire polygon about its centre.
    const inset=points.map((p,i)=>{
      const prev=points[(i+points.length-1)%points.length],next=points[(i+1)%points.length];
      const pl=lengths[(i+points.length-1)%points.length],nl=lengths[i];
      const n1=[-(p[1]-prev[1])/pl,(p[0]-prev[0])/pl],n2=[-(next[1]-p[1])/nl,(next[0]-p[0])/nl];
      const f=b/Math.max(.1,1+n1[0]*n2[0]+n1[1]*n2[1]);
      return [p[0]+(n1[0]+n2[0])*f,p[1]+(n1[1]+n2[1])*f];
    });
    const clip=ps=>'polygon('+ps.map(([x,y])=>`${x}px ${y}px`).join(',')+')';
    const radius=typeof outline==='object'&&Number.isFinite(outline.radius)?outline.radius:null;
    if(radius!==null||isRectangle(points)){
      // Same shape, no offscreen surface: a box inset by the bevel, rounded like the outline.
      for(const cap of [front,back])Object.assign(cap.style,{left:b+'px',top:b+'px',width:Math.max(0,width-2*b)+'px',height:Math.max(0,height-2*b)+'px',borderRadius:radius!==null?radius+'%':''});
    } else {
      front.style.clipPath=clip(inset);
      back.style.clipPath=clip(inset.map(([x,y])=>[width-x,y]));
    }
    for(let i=0;i<points.length;i++){
      const a=points[i],c=points[(i+1)%points.length],ia=inset[i],ic=inset[(i+1)%points.length];
      const dx=c[0]-a[0],dy=c[1]-a[1],len=Math.hypot(dx,dy);if(len<.001)continue;
      const angle=Math.atan2(dy,dx),ux=dx/len,uy=dy/len;
      const wall=node('solid-wall');
      wall.style.cssText=`width:${len+.15}px;height:${depth-2*b}px;transform:translate3d(${a[0]}px,${a[1]}px,${-depth/2+b}px) rotateZ(${angle}rad) rotateX(90deg);--edge-light:${Math.max(0,.12-uy*.10-ux*.08)}`;
      root.append(wall);
      if(!b)continue;
      const inward=(ia[0]-a[0])*(-uy)+(ia[1]-a[1])*ux;
      const slope=Math.hypot(inward,b),shift=(ia[0]-a[0])*ux+(ia[1]-a[1])*uy;
      for(const side of [-1,1]){
        const face=node('solid-bevel');
        const z=side*(depth/2-b),vyx=-uy*inward/slope,vyy=ux*inward/slope,vyz=side*b/slope;
        const innerLen=Math.hypot(ic[0]-ia[0],ic[1]-ia[1]);
        // A bevel is at most ~1px tall, so its trapezoid ends are sub-pixel: draw it as a plain strip.
        face.style.cssText=`width:${len}px;height:${slope}px;transform:matrix3d(${ux},${uy},0,0,${vyx},${vyy},${vyz},0,0,0,1,0,${a[0]},${a[1]},${z},1);--bevel-light:${side>0?.28:.08}`;
        root.append(face);
      }
    }
    root.append(back,front);return {root,front,back};
  }
  return {prism,rounded};
})();
