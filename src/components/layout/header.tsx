interface HeaderProps {
  children?: React.ReactNode;
}

export function Header({ children }: HeaderProps) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-6 lg:px-8">
      {/* Spacer for mobile menu button */}
      <div className="lg:hidden w-10" />
      <div className="flex flex-1 items-center justify-between">
        {children}
      </div>
    </header>
  );
}
