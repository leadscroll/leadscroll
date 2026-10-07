import { initialTags, type TagState } from './model';
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useMemo,
  useState,
} from 'react';

export const tagsPreviewEnabled =
  import.meta.env.DEV && import.meta.env.MODE === 'design-preview';
const TagContext = createContext<null | {
  setState: Dispatch<SetStateAction<TagState>>;
  state: TagState;
}>(null);

const PreviewProvider = ({ children }: { readonly children: ReactNode }) => {
  const [state, setState] = useState(initialTags);
  const value = useMemo(() => ({ setState, state }), [state]);
  return <TagContext.Provider value={value}>{children}</TagContext.Provider>;
};

export const TagPreviewProvider = ({
  children,
}: {
  readonly children: ReactNode;
}) =>
  tagsPreviewEnabled ? <PreviewProvider>{children}</PreviewProvider> : children;
export const useTags = () => useContext(TagContext);
