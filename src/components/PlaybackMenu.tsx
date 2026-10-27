import {createContext,useContext,type ReactNode} from "react";
import {createPortal} from "react-dom";
export const PlaybackMenuContext=createContext<{host:HTMLElement|null;close:()=>void}|null>(null);
export const usePlaybackMenu=()=>useContext(PlaybackMenuContext);
export function PlaybackExtra({children}:{children:ReactNode}){
  const menu=usePlaybackMenu();
  return menu?.host ? createPortal(children,menu.host) : <>{children}</>;
}
