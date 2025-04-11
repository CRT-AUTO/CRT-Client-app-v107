import React, { useEffect, useState, useCallback, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { supabase, clearSupabaseAuth, refreshSupabaseToken, getSessionWithTimeout, getSessionWithRetry } from './lib/supabase';
import { getCurrentUser } from './lib/auth';
import Layout from './components/Layout';
import Auth from './components/Auth';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import Messages from './pages/Messages';
import MessageDetail from './pages/MessageDetail';
import FacebookCallback from './pages/FacebookCallback';
import InstagramCallback from './pages/InstagramCallback';
import DeletionStatus from './pages/DeletionStatus';
import AdminLayout from './pages/admin/AdminLayout';
import AdminDashboard from './pages/admin/AdminDashboard';
import AdminUserManagement from './pages/admin/AdminUserManagement';
import AdminUserDetail from './pages/admin/AdminUserDetail';
import AdminWebhookSetup from './pages/admin/AdminWebhookSetup';
import AppErrorBoundary from './components/AppErrorBoundary';
import ConnectionStatus from './components/ConnectionStatus';
import type { User } from './types';

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [connectionRetries, setConnectionRetries] = useState(0);
  const [debugInfo, setDebugInfo] = useState<string[]>([]);
  const [forceReset, setForceReset] = useState(false);
  const [signOutInProgress, setSignOutInProgress] = useState(false);
  const [initAttempted, setInitAttempted] = useState(false);
  const [forcedClearCompleted, setForcedClearCompleted] = useState(false);
  const [sessionCheckTimeout, setSessionCheckTimeout] = useState(false);
  const [oauthReturnDetected, setOauthReturnDetected] = useState(false);
  
  // Reference to store timeout ID for session refresh
  const refreshTimerRef = useRef<number | null>(null);

  const addDebugInfo = (message: string) => {
    console.log(`App initialization: ${message}`);
    setDebugInfo(prev => [...prev.slice(-9), message]);
  };

  // Detect OAuth return early to prevent unnecessary authentication clearing
  useEffect(() => {
    // Check for OAuth return indicators in the URL or localStorage
    const isOAuthReturn = 
      window.location.pathname.includes('/oauth/facebook/callback') || 
      window.location.pathname.includes('/oauth/instagram/callback') ||
      localStorage.getItem('fb_auth_state') !== null;
    
    if (isOAuthReturn) {
      addDebugInfo("Detected OAuth return, will skip forced auth clearing");
      setOauthReturnDetected(true);
    }
  }, []);

  useEffect(() => {
    // Check for Facebook return before running clearAuth
    // We don't want to clear auth if we're returning from Facebook
    if (oauthReturnDetected || 
        window.location.pathname.includes('/oauth/facebook/callback') || 
        window.location.pathname.includes('/oauth/instagram/callback') ||
        localStorage.getItem('fb_auth_state') !== null) {
      addDebugInfo("Detected OAuth return, skipping forced clear");
      setForcedClearCompleted(true);
    } else {
      // Not an OAuth return, perform the force clear
      const forceClearAuth = async () => {
        // Skip forced sign out if we're returning from Facebook
        const isFacebookReturn = localStorage.getItem('fb_auth_state') !== null;
        
        if (isFacebookReturn) {
          addDebugInfo("Skipping forced sign out due to Facebook auth return");
          setForcedClearCompleted(true);
          return;
        }
        
        // Only attempt once 
        if (signOutInProgress || initAttempted || forcedClearCompleted) {
          return;
        }
        
        try {
          setSignOutInProgress(true);
          setInitAttempted(true);
          addDebugInfo("Performing forced sign out to clear any stale sessions");
          await clearSupabaseAuth();
          addDebugInfo("Forced sign out completed");
          setForcedClearCompleted(true);
        } catch (err) {
          addDebugInfo(`Error during forced sign out: ${err instanceof Error ? err.message : 'Unknown'}`);
          setForcedClearCompleted(true); // Mark as completed even on error to avoid retries
        } finally {
          setSignOutInProgress(false);
        }
      };
      
      forceClearAuth();
    }
  }, [forceReset, oauthReturnDetected]);

  // Set up session refresh mechanism
  const setupSessionRefresh = useCallback((expiresAt: number) => {
    // Clear any existing timer
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    
    const now = Date.now() / 1000; // current time in seconds
    const timeUntilExpiry = expiresAt - now;
    
    // Set refresh to happen at 80% of the way to expiry
    // For example, if token lasts 1 hour, refresh after 48 minutes
    const refreshDelay = timeUntilExpiry * 0.8 * 1000; // convert to ms
    
    // Ensure we're not setting a negative delay or too short
    const finalDelay = Math.max(refreshDelay, 5000);
    
    addDebugInfo(`Setting session refresh in ${Math.floor(finalDelay / 1000)} seconds`);
    
    refreshTimerRef.current = window.setTimeout(async () => {
      addDebugInfo("Executing scheduled token refresh");
      const success = await refreshSupabaseToken();
      
      if (success) {
        addDebugInfo("Scheduled token refresh successful");
        
        // Check the new session to set up the next refresh
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
          setupSessionRefresh(session.expires_at);
        }
      } else {
        addDebugInfo("Scheduled token refresh failed - trying again soon");
        // If refresh failed, try again soon
        refreshTimerRef.current = window.setTimeout(() => {
          refreshSupabaseToken();
        }, 30000); // try again in 30 seconds
      }
    }, finalDelay);
    
  }, []);

  useEffect(() => {
    // Only initialize auth after forced sign-out completes
    // or if we're returning from a Facebook auth flow
    if (signOutInProgress) return;
    
    // Always attempt auth if we're returning from OAuth or have skipped forced clear
    // This ensures OAuth flows can complete properly
    const isFacebookReturn = localStorage.getItem('fb_auth_state') !== null;
    const shouldAttemptAuth = forcedClearCompleted || isFacebookReturn || 
                             window.location.pathname.includes('/oauth/');
     
    if (!shouldAttemptAuth) return;
    
    async function initializeAuth() {
      try {
        setLoading(true);
        setError(null);
        setSessionCheckTimeout(false);
        addDebugInfo("Starting initialization");

        // Get the current session first with a timeout to prevent hanging
        addDebugInfo("Checking session");
        let sessionResult;
        try {
          // For OAuth returns, use the enhanced retry version to handle 2FA scenarios
          if (isFacebookReturn || window.location.pathname.includes('/oauth/')) {
            addDebugInfo("Using enhanced session check with retry for OAuth return");
            sessionResult = await getSessionWithRetry(15000, 1000);
          } else {
            sessionResult = await getSessionWithTimeout(8000);
          }
        } catch (timeoutError) {
          addDebugInfo(`Session check timed out: ${timeoutError instanceof Error ? timeoutError.message : 'Unknown error'}`);
          setSessionCheckTimeout(true);
          
          // If we're returning from Facebook OAuth, we should try to continue anyway
          if (isFacebookReturn || window.location.pathname.includes('/oauth/')) {
            addDebugInfo("Session check timed out during OAuth return - attempting to continue");
          } else {
            setError('Session check timed out. Please try again or log in again.');
            setLoading(false);
            return;
          }
        }
        
        // Continue with session handling if we have a session result
        const { data: { session } = { session: null }, error: sessionError } = sessionResult || {};
        
        if (sessionError) {
          console.error('Error getting session:', sessionError);
          addDebugInfo(`Session error: ${sessionError.message}`);
          setError('Failed to check authentication status');
          setLoading(false);
          return;
        }

        // Check if we're returning from Facebook OAuth
        const isOAuthReturn = isFacebookReturn || 
                             window.location.pathname.includes('/oauth/facebook/callback') ||
                             window.location.pathname.includes('/oauth/instagram/callback');
                             
        if (isOAuthReturn) {
          addDebugInfo("Detected OAuth return, preserving session state");
        }

        // If no session, we can stop here
        if (!session) {
          addDebugInfo("No session found");
          setUser(null);
          setLoading(false);
          setAuthChecked(true);
          return;
        }

        addDebugInfo(`Session found for: ${session.user?.email || 'unknown'}`);

        // Log important session details
        addDebugInfo(`Session expires at: ${new Date(session.expires_at * 1000).toLocaleTimeString()}`);
        
        // Setup automatic token refresh
        setupSessionRefresh(session.expires_at);

        // Verify session validity by attempting to get user data
        try {
          addDebugInfo("Getting user data");
          const currentUser = await getCurrentUser();
          
          if (!currentUser) {
            addDebugInfo("User data not found - session appears to be invalid");
            
            if (isOAuthReturn) {
              addDebugInfo("Preserving session due to OAuth return");
              // Try again to get user data after a short delay
              setTimeout(async () => {
                try {
                  const retryUser = await getCurrentUser();
                  if (retryUser) {
                    addDebugInfo("User data retrieved on retry");
                    setUser(retryUser);
                  }
                } catch (retryError) {
                  addDebugInfo(`Retry error: ${retryError instanceof Error ? retryError.message : 'Unknown'}`);
                }
              }, 1000);
            } else {
              setUser(null);
            }
            
            setAuthChecked(true);
            setLoading(false);
            return;
          }
          
          addDebugInfo(`User data retrieved: ${currentUser.email || 'null'}`);
          setUser(currentUser);
        } catch (userError) {
          console.error('Error getting user data:', userError);
          addDebugInfo(`User data error: ${userError instanceof Error ? userError.message : 'Unknown'}`);
          
          // Don't automatically clear session if returning from OAuth
          if (!isOAuthReturn) {
            setUser(null);
          } else {
            addDebugInfo("Preserving user state due to OAuth return");
          }
        }
        
        setAuthChecked(true);
      } catch (err) {
        console.error('Error initializing auth:', err);
        addDebugInfo(`Initialization error: ${err instanceof Error ? err.message : 'Unknown'}`);
        setError('Failed to initialize application');
      } finally {
        setLoading(false);
      }
    }

    const initTimeout = setTimeout(() => {
      if (!signOutInProgress) {
        initializeAuth();
      }
    }, 100); // Short delay to ensure sequential processing

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      addDebugInfo(`Auth state change: ${event}`);
      
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        try {
          const currentUser = await getCurrentUser();
          if (currentUser) {
            setUser(currentUser);
            addDebugInfo(`User signed in: ${currentUser.email || 'unknown'}`);
            
            // Setup session refresh timer when signed in or token refreshed
            if (session) {
              addDebugInfo(`New session expires at: ${new Date(session.expires_at * 1000).toLocaleTimeString()}`);
              setupSessionRefresh(session.expires_at);
            }
          } else {
            addDebugInfo('Auth event received but user data not found');
            // Don't automatically clear session here - might be transitioning
          }
        } catch (err) {
          console.error('Error handling auth change:', err);
          addDebugInfo(`Auth change error: ${err instanceof Error ? err.message : 'Unknown'}`);
        }
      } else if (event === 'SIGNED_OUT') {
        setUser(null);
        addDebugInfo('User signed out');
        
        // Clear any refresh timers on signout
        if (refreshTimerRef.current) {
          clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = null;
        }
      }
    });

    return () => {
      clearTimeout(initTimeout);
      if (subscription) {
        subscription.unsubscribe();
      }
      // Clear any refresh timer on cleanup
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [connectionRetries, signOutInProgress, setupSessionRefresh, forcedClearCompleted]);

  // Add a timeout detection mechanism
  useEffect(() => {
    if (loading && !authChecked) {
      // If loading takes more than 10 seconds, show a timeout warning
      const timeoutWarning = setTimeout(() => {
        if (loading && !authChecked) {
          addDebugInfo("Initialization seems to be taking longer than expected");
        }
      }, 10000);
      
      return () => clearTimeout(timeoutWarning);
    }
  }, [loading, authChecked]);

  // Add a heartbeat mechanism to periodically check session health
  useEffect(() => {
    // Every 5 minutes, check session health (reduced from 2 minutes)
    const heartbeatInterval = setInterval(async () => {
      // Only run if user is supposed to be logged in
      if (user) {
        try {
          addDebugInfo("Running session health check");
          try {
            // Use timeout version to prevent hanging
            const result = await getSessionWithTimeout(5000);
            const session = result.data?.session;
            
            if (!session) {
              addDebugInfo("Session lost during heartbeat check");
              // If session disappeared, try to recover it
              const success = await refreshSupabaseToken();
              if (!success) {
                addDebugInfo("Failed to recover session, forcing re-auth");
                setUser(null);
                // Don't clear auth here, let user re-authenticate
              } else {
                addDebugInfo("Successfully recovered session");
              }
            } else {
              // Log remaining time but only if it's close to expiry
              const expiresAt = new Date(session.expires_at * 1000);
              const now = new Date();
              const minutesRemaining = Math.round((expiresAt.getTime() - now.getTime()) / 60000);
              
              if (minutesRemaining < 30) {
                // Only log if less than 30 minutes remain
                addDebugInfo(`Session expiring soon: ${minutesRemaining} minutes remaining`);
              }
            }
          } catch (timeoutError) {
            addDebugInfo("Session health check timed out. This might indicate connectivity issues.");
          }
        } catch (err) {
          console.error('Error in heartbeat check:', err);
          addDebugInfo(`Heartbeat error: ${err instanceof Error ? err.message : 'Unknown'}`);
        }
      }
    }, 300000); // 5 minutes
    
    return () => clearInterval(heartbeatInterval);
  }, [user]);

  const handleRetry = () => {
    setConnectionRetries(prev => prev + 1);
    setForceReset(prev => !prev);
    setSessionCheckTimeout(false);
    addDebugInfo(`Retrying connection (attempt ${connectionRetries + 1})`);
  };

  const handleForceReset = async () => {
    addDebugInfo("User initiated full reset");
    
    try {
      // Clear any stored auth session
      await clearSupabaseAuth();
      
      // Clear Facebook auth state if present
      if (localStorage.getItem('fb_auth_state')) {
        localStorage.removeItem('fb_auth_state');
        addDebugInfo("Cleared Facebook auth state");
      }
      
      // Force reload the application
      window.location.href = '/auth';
    } catch (error) {
      console.error("Error during force reset:", error);
      addDebugInfo(`Force reset error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  // Show loading spinner only during initial load
  if (loading && !authChecked) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mb-4"></div>
        <p className="text-gray-600">Initializing application...</p>
        
        {sessionCheckTimeout && (
          <div className="mt-4 text-amber-600 text-sm flex items-center">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            Session check is taking longer than expected. The server might be busy.
          </div>
        )}
        
        {/* Debug information */}
        {debugInfo.length > 0 && (
          <div className="mt-8 p-4 bg-gray-100 rounded-md max-w-md">
            <h3 className="text-sm font-medium text-gray-700 mb-2">Initialization Status:</h3>
            <div className="text-xs text-gray-600 space-y-1">
              {debugInfo.map((info, idx) => (
                <div key={idx} className="bg-white p-1 rounded">{info}</div>
              ))}
            </div>
            
            {/* Timeout detection - add reset options if taking too long */}
            {debugInfo.length > 2 && (
              <div className="mt-4 flex flex-col space-y-2">
                <button
                  onClick={handleRetry}
                  className="py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
                >
                  Initialization taking too long? Click to retry
                </button>
                <button
                  onClick={handleForceReset}
                  className="py-2 px-4 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                >
                  Force reset and go to login
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Show error state with retry button
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center max-w-md">
          <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-md mb-4">
            {error}
          </div>
          <button
            onClick={handleRetry}
            className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            Retry
          </button>
          
          <button
            onClick={handleForceReset}
            className="ml-2 inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
          >
            Reset & Go to Login
          </button>
          
          {/* Debug information */}
          {debugInfo.length > 0 && (
            <div className="mt-8 p-4 bg-gray-100 rounded-md">
              <h3 className="text-sm font-medium text-gray-700 mb-2">Debug Information:</h3>
              <div className="text-xs text-gray-600 space-y-1">
                {debugInfo.map((info, idx) => (
                  <div key={idx} className="bg-white p-1 rounded">{info}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <AppErrorBoundary>
      <ConnectionStatus onRetry={handleRetry} />
      <BrowserRouter>
        <Routes>
          {!user ? (
            <>
              <Route path="/auth" element={<Auth />} />
              <Route path="/deletion-status" element={<DeletionStatus />} />
              <Route path="*" element={<Navigate to="/auth" replace />} />
            </>
          ) : (
            <>
              <Route element={<Layout />}>
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/messages" element={<Messages />} />
                <Route path="/messages/:id" element={<MessageDetail />} />
                <Route path="/settings" element={<Settings />} />
              </Route>
              
              {user.role === 'admin' && (
                <Route path="/admin" element={<AdminLayout />}>
                  <Route index element={<AdminDashboard />} />
                  <Route path="users" element={<AdminUserManagement />} />
                  <Route path="users/:userId" element={<AdminUserDetail />} />
                  <Route path="webhooks" element={<AdminWebhookSetup />} />
                </Route>
              )}
              
              <Route path="/oauth/facebook/callback" element={<FacebookCallback />} />
              <Route path="/oauth/instagram/callback" element={<InstagramCallback />} />
              <Route path="/deletion-status" element={<DeletionStatus />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </>
          )}
        </Routes>
      </BrowserRouter>
    </AppErrorBoundary>
  );
}

export default App;
