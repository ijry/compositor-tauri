/** 图层树的统一遍历：同级按数组顺序，组与子孙作为完整块。 */
import type { Layer } from '@/types/document';

export interface HierarchyRow { layer: Layer; depth: number }
export function hierarchyRows(layers: readonly Layer[], options: {topFirst?:boolean;respectCollapsed?:boolean} = {}): HierarchyRow[] {
  const groups=new Set(layers.filter(layer=>layer.kind==='group').map(layer=>layer.id));
  const children=new Map<string|null,Layer[]>();
  for(const layer of layers) {
    // 损坏的父引用退回根级，正常工程的循环引用仍由加载校验拒绝。
    const parent=layer.parentId && layer.parentId!==layer.id && groups.has(layer.parentId)?layer.parentId:null;
    const list=children.get(parent)??[];list.push(layer);children.set(parent,list);
  }
  const pending:HierarchyRow[]=[],result:HierarchyRow[]=[],visited=new Set<string>();
  const push=(parent:string|null,depth:number)=>{
    const list=children.get(parent)??[],ordered=options.topFirst?[...list].reverse():list;
    for(let i=ordered.length-1;i>=0;i--)pending.push({layer:ordered[i]!,depth});
  };
  push(null,0);
  while(pending.length) {
    const row=pending.pop()!;
    if(visited.has(row.layer.id))continue;
    visited.add(row.layer.id);result.push(row);
    if(row.layer.kind==='group' && (!options.respectCollapsed || row.layer.expanded))push(row.layer.id,row.depth+1);
  }
  return result;
}
