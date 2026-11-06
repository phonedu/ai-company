import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';

import { cn } from '../../lib/utils';
import { CheckIcon, SearchIcon } from '../icons';

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground',
        className,
      )}
      {...props}
    />
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex h-12 items-center gap-2 border-b border-border px-4">
      <SearchIcon />
      <CommandPrimitive.Input
        className={cn(
          'flex h-full w-full bg-transparent text-[14px] outline-none placeholder:text-text-dim',
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn('max-h-[320px] overflow-y-auto overflow-x-hidden p-2', className)}
      {...props}
    />
  );
}

function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      className="py-6 text-center text-[13px] text-text-dim"
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn('overflow-hidden text-foreground', className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'group/item relative flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-[13px] outline-none',
        'data-[selected=true]:bg-secondary data-[selected=true]:text-secondary-foreground',
        className,
      )}
      {...props}
    >
      {children}
      <span className="ml-auto opacity-0 group-data-[selected=true]/item:opacity-100">
        <CheckIcon />
      </span>
    </CommandPrimitive.Item>
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn('h-px bg-border', className)} {...props} />;
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return <span className={cn('ml-auto text-[11px] text-text-dim', className)} {...props} />;
}

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
};
