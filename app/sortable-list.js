(function(global){
  function bind(options){
    const handle=options.handle,row=options.row,container=options.container;
    if(!handle||!row||!container)return;
    handle.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;
      if(options.canStart&&!options.canStart()){event.preventDefault();options.onBlocked&&options.onBlocked();return;}
      event.preventDefault();event.stopPropagation();
      let moved=false;row.classList.add('dragging');document.body.classList.add('reordering');
      const clear=()=>container.querySelectorAll(options.itemSelector).forEach(x=>x.classList.remove('drag-over-before','drag-over-after'));
      const move=pointer=>{
        const hit=document.elementFromPoint(pointer.clientX,pointer.clientY),target=hit&&hit.closest?hit.closest(options.itemSelector):null;
        if(!target||target===row||!container.contains(target))return;
        const rect=target.getBoundingClientRect(),after=pointer.clientY>rect.top+rect.height/2;
        clear();target.classList.add(after?'drag-over-after':'drag-over-before');container.insertBefore(row,after?target.nextSibling:target);moved=true;
      };
      const stop=()=>{
        document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',stop);document.removeEventListener('pointercancel',stop);
        clear();row.classList.remove('dragging');document.body.classList.remove('reordering');
        if(moved&&options.onCommit)options.onCommit([...container.querySelectorAll(options.itemSelector)]);
      };
      document.addEventListener('pointermove',move);document.addEventListener('pointerup',stop);document.addEventListener('pointercancel',stop);
    });
  }
  global.PointerSortable={bind};
})(window);
