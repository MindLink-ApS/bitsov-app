import { createContext, createSignal, onCleanup, useContext, type Accessor, type ParentProps } from 'solid-js';

// Each mounted review/ceremony owns its guard. Accessors are read synchronously,
// including by click handlers, so a new intent can never race an effect update.
const PairingActivity = createContext<{
  blocked: Accessor<boolean>;
  register: (active: Accessor<boolean>) => () => void;
}>();

export function PairingActivityProvider(props: ParentProps) {
  const [activities, setActivities] = createSignal<Accessor<boolean>[]>([]);
  const value = {
    blocked: () => activities().some(active => active()),
    register: (active: Accessor<boolean>) => {
      setActivities(current => [...current, active]);
      return () => setActivities(current => current.filter(item => item !== active));
    },
  };
  return <PairingActivity.Provider value={value}>{props.children}</PairingActivity.Provider>;
}

export function usePairingActivity(active: Accessor<boolean>) {
  const activity = useContext(PairingActivity);
  if (activity) onCleanup(activity.register(active));
}

export function usePairingBlocked(): Accessor<boolean> {
  return useContext(PairingActivity)?.blocked ?? (() => false);
}
