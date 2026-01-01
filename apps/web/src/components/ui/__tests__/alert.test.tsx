import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Alert, AlertTitle, AlertDescription } from '../alert';

describe('Alert', () => {
  describe('Rendering', () => {
    it('should render alert with children', () => {
      render(<Alert>Test alert content</Alert>);
      expect(screen.getByRole('alert')).toHaveTextContent('Test alert content');
    });

    it('should have data-slot="alert" attribute', () => {
      render(<Alert>Test</Alert>);
      expect(screen.getByRole('alert')).toHaveAttribute('data-slot', 'alert');
    });

    it('should have role="alert" for accessibility', () => {
      render(<Alert>Test</Alert>);
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('should merge custom className with default classes', () => {
      render(<Alert className="custom-class">Test</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('custom-class');
      expect(alert).toHaveClass('rounded-lg');
    });

    it('should pass through additional props', () => {
      render(<Alert data-testid="custom-alert" id="my-alert">Test</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveAttribute('data-testid', 'custom-alert');
      expect(alert).toHaveAttribute('id', 'my-alert');
    });
  });

  describe('Variants', () => {
    it('should render default variant with correct classes', () => {
      render(<Alert variant="default">Default alert</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('bg-card');
      expect(alert).toHaveClass('text-card-foreground');
    });

    it('should render default variant when no variant is specified', () => {
      render(<Alert>Default alert</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('bg-card');
      expect(alert).toHaveClass('text-card-foreground');
    });

    it('should render destructive variant with correct classes', () => {
      render(<Alert variant="destructive">Destructive alert</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('text-destructive');
      expect(alert).toHaveClass('bg-card');
    });

    it('should render success variant with correct classes', () => {
      render(<Alert variant="success">Success alert</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('text-success');
      expect(alert).toHaveClass('bg-card');
    });

    it('should render warning variant with correct classes', () => {
      render(<Alert variant="warning">Warning alert</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('text-warning');
      expect(alert).toHaveClass('bg-card');
    });

    it('should render info variant with correct classes', () => {
      render(<Alert variant="info">Info alert</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('text-info');
      expect(alert).toHaveClass('bg-card');
    });
  });

  describe('Common styling', () => {
    it('should have common structural classes for all variants', () => {
      const variants = ['default', 'destructive', 'success', 'warning', 'info'] as const;

      variants.forEach((variant) => {
        const { unmount } = render(<Alert variant={variant}>Test</Alert>);
        const alert = screen.getByRole('alert');

        expect(alert).toHaveClass('rounded-lg');
        expect(alert).toHaveClass('border');
        expect(alert).toHaveClass('px-4');
        expect(alert).toHaveClass('py-3');
        expect(alert).toHaveClass('text-sm');

        unmount();
      });
    });
  });
});

describe('AlertTitle', () => {
  it('should render title with children', () => {
    render(<AlertTitle>Alert Title</AlertTitle>);
    expect(screen.getByText('Alert Title')).toBeInTheDocument();
  });

  it('should have data-slot="alert-title" attribute', () => {
    render(<AlertTitle>Title</AlertTitle>);
    expect(screen.getByText('Title')).toHaveAttribute('data-slot', 'alert-title');
  });

  it('should have correct styling classes', () => {
    render(<AlertTitle>Title</AlertTitle>);
    const title = screen.getByText('Title');
    expect(title).toHaveClass('font-medium');
    expect(title).toHaveClass('tracking-tight');
    expect(title).toHaveClass('col-start-2');
  });

  it('should merge custom className', () => {
    render(<AlertTitle className="custom-title">Title</AlertTitle>);
    const title = screen.getByText('Title');
    expect(title).toHaveClass('custom-title');
    expect(title).toHaveClass('font-medium');
  });

  it('should pass through additional props', () => {
    render(<AlertTitle data-testid="custom-title">Title</AlertTitle>);
    expect(screen.getByText('Title')).toHaveAttribute('data-testid', 'custom-title');
  });
});

describe('AlertDescription', () => {
  it('should render description with children', () => {
    render(<AlertDescription>Alert description text</AlertDescription>);
    expect(screen.getByText('Alert description text')).toBeInTheDocument();
  });

  it('should have data-slot="alert-description" attribute', () => {
    render(<AlertDescription>Description</AlertDescription>);
    expect(screen.getByText('Description')).toHaveAttribute('data-slot', 'alert-description');
  });

  it('should have correct styling classes', () => {
    render(<AlertDescription>Description</AlertDescription>);
    const description = screen.getByText('Description');
    expect(description).toHaveClass('text-muted-foreground');
    expect(description).toHaveClass('text-sm');
    expect(description).toHaveClass('col-start-2');
  });

  it('should merge custom className', () => {
    render(<AlertDescription className="custom-desc">Description</AlertDescription>);
    const description = screen.getByText('Description');
    expect(description).toHaveClass('custom-desc');
    expect(description).toHaveClass('text-muted-foreground');
  });

  it('should pass through additional props', () => {
    render(<AlertDescription data-testid="custom-desc">Description</AlertDescription>);
    expect(screen.getByText('Description')).toHaveAttribute('data-testid', 'custom-desc');
  });
});

describe('Alert composition', () => {
  it('should render complete alert with title and description', () => {
    render(
      <Alert variant="success">
        <AlertTitle>Success!</AlertTitle>
        <AlertDescription>Your changes have been saved.</AlertDescription>
      </Alert>
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-slot', 'alert');
    expect(screen.getByText('Success!')).toHaveAttribute('data-slot', 'alert-title');
    expect(screen.getByText('Your changes have been saved.')).toHaveAttribute('data-slot', 'alert-description');
  });

  it('should render alert with icon and content', () => {
    render(
      <Alert variant="info">
        <svg data-testid="info-icon" />
        <AlertTitle>Information</AlertTitle>
        <AlertDescription>Here is some useful information.</AlertDescription>
      </Alert>
    );

    expect(screen.getByTestId('info-icon')).toBeInTheDocument();
    expect(screen.getByText('Information')).toBeInTheDocument();
    expect(screen.getByText('Here is some useful information.')).toBeInTheDocument();
  });

  it('should work with all variants in composition', () => {
    const variants = ['default', 'destructive', 'success', 'warning', 'info'] as const;

    variants.forEach((variant) => {
      const { unmount } = render(
        <Alert variant={variant}>
          <AlertTitle>Title for {variant}</AlertTitle>
          <AlertDescription>Description for {variant}</AlertDescription>
        </Alert>
      );

      const alert = screen.getByRole('alert');
      expect(alert).toHaveAttribute('data-slot', 'alert');
      expect(screen.getByText(`Title for ${variant}`)).toHaveAttribute('data-slot', 'alert-title');
      expect(screen.getByText(`Description for ${variant}`)).toHaveAttribute('data-slot', 'alert-description');

      unmount();
    });
  });
});
